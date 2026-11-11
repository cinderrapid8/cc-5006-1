import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { renderProject } from "./render.js";
import { reviveProject, serializeProject } from "./timeline.js";

// Render job manager.
// Invariants:
//  - A job renders a deep-frozen snapshot (its own revision file); later edits
//    to the live project never change what the job sees.
//  - Job completion writes into the final directory and only then registers the
//    product. A cancelled or failed job only ever touches its work directory.
//  - The preview snapshot is keyed by project revision. An old job finishing
//    late cannot overwrite the preview of a newer revision.
export class JobManager {
  constructor({ store, roots }) {
    this.store = store;
    this.workRoot = roots.work;
    this.finalRoot = roots.final;
    this.jobs = new Map();
    this.products = new Map(); // projectId -> [{jobId, revision, video, manifest, createdAt}]
  }

  async init() {
    await fs.mkdir(this.workRoot, { recursive: true });
    await fs.mkdir(this.finalRoot, { recursive: true });
  }

  status(jobId) {
    const j = this.jobs.get(jobId);
    if (!j) return null;
    return {
      jobId, projectId: j.projectId, revision: j.revision,
      state: j.state, progress: j.progress, phase: j.phase,
      error: j.error || null, headroom: j.headroom || null,
      startedAt: j.startedAt, finishedAt: j.finishedAt || null,
    };
  }

  list(projectId) {
    return [...this.jobs.values()]
      .filter((j) => j.projectId === projectId)
      .map((j) => this.status(j.jobId))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  listProducts(projectId) {
    return this.products.get(projectId) || [];
  }

  // Start a render from the project's CURRENT revision. The snapshot is written
  // as a separate frozen document so concurrent edits cannot mutate job input.
  async start(project) {
    const jobId = randomUUID().slice(0, 8);
    const workDir = path.join(this.workRoot, jobId);
    await fs.mkdir(workDir, { recursive: true });

    // Deep freeze via serialization round-trip; BigInts revived.
    const frozen = reviveProject(JSON.parse(serializeProject(project)));
    frozen.revision = project.revision;
    await fs.writeFile(
      path.join(workDir, "frozen-input.json"),
      serializeProject(frozen),
    );

    const job = {
      jobId, projectId: project.id, revision: project.revision,
      state: "queued", progress: 0, phase: "queued", error: null,
      headroom: null, startedAt: new Date().toISOString(), finishedAt: null,
      workDir, cancel: null,
    };
    this.jobs.set(jobId, job);

    // Run without await: the caller gets the job id immediately.
    this._run(job, frozen);
    return this.status(jobId);
  }

  async _run(job, frozen) {
    job.state = "running";
    try {
      const emit = (ev) => {
        if (ev.phase === "clip-progress" || ev.phase === "assemble") {
          job.progress = ev.fraction;
          job.phase = ev.phase;
        } else {
          job.phase = ev.phase;
        }
      };
      const result = await renderProject({
        frozen,
        workDir: job.workDir,
        finalDir: this.finalRoot,
        jobId: job.jobId,
        emit,
        shouldCancel: () => job.state === "cancelled",
        registerHandle: (h) => { job.cancelHandle = h; },
      });
      if (job.state === "cancelled") return;

      const entry = {
        jobId: job.jobId,
        revision: job.revision,
        video: result.video,
        manifest: result.manifest,
        manifestDoc: result.manifestDoc,
        createdAt: new Date().toISOString(),
      };
      const list = this.products.get(job.projectId) || [];
      list.unshift(entry);
      this.products.set(job.projectId, list);

      job.state = "done";
      job.progress = 1;
      job.phase = "done";
      job.finishedAt = new Date().toISOString();
      job.result = { video: result.video, manifest: result.manifest };
    } catch (e) {
      if (e.cancelled || job.state === "cancelled") {
        job.state = "cancelled";
      } else {
        job.state = "failed";
        job.error = e.message;
        if (e.code === "HEADROOM" || e.code === "HEADROOM_MEASURED") {
          job.headroom = e.details;
        }
      }
      job.finishedAt = new Date().toISOString();
    } finally {
      // Temp files of a finished/cancelled/failed job never reach the final dir.
      await fs.rm(job.workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  cancel(jobId) {
    const job = this.jobs.get(jobId);
    if (!job || (job.state !== "running" && job.state !== "queued")) {
      return false;
    }
    job.state = "cancelled";
    job.phase = "cancelled";
    if (job.cancelHandle) {
      try { job.cancelHandle.cancel(); } catch { /* process may already be gone */ }
    }
    return true;
  }
}
