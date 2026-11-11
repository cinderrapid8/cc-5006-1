import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { renderProject } from "./render.js";
import { reviveProject, serializeProject } from "./timeline.js";

// Preview renders use the same exact engine on a frozen revision snapshot, with
// a small frame size for speed. Previews are registered by revision: if the
// project was edited while the preview was rendering, the stale result is
// discarded instead of replacing the current preview.
export class PreviewService {
  constructor({ previewDir, finalRoot, workRoot }) {
    this.previewDir = previewDir;
    this.finalRoot = finalRoot;
    this.workRoot = workRoot;
    this.registry = new Map(); // projectId -> { revision, jobId, state, url, manifest }
    this.handles = new Map();
  }

  async init() {
    await fs.mkdir(this.previewDir, { recursive: true });
  }

  status(projectId) {
    return this.registry.get(projectId) || { state: "idle" };
  }

  async render(project) {
    const projectId = project.id;
    const revision = project.revision;
    const jobId = `preview_${randomUUID().slice(0, 8)}`;
    const workDir = path.join(this.workRoot, jobId);
    await fs.mkdir(workDir, { recursive: true });

    const frozen = reviveProject(JSON.parse(serializeProject(project)));
    frozen.revision = revision;
    frozen.output = { ...frozen.output, width: 256, height: 144 };

    this.registry.set(projectId, {
      revision, jobId, state: "running", progress: 0,
      requestedAt: new Date().toISOString(),
    });

    (async () => {
      try {
        const result = await renderProject({
          frozen,
          workDir,
          finalDir: this.previewDir,
          jobId,
          emit: (ev) => {
            const cur = this.registry.get(projectId);
            if (cur && cur.jobId === jobId) {
              cur.progress = ev.fraction ?? cur.progress;
              cur.phase = ev.phase;
            }
          },
          shouldCancel: () => {
            const cur = this.registry.get(projectId);
            return !cur || cur.jobId !== jobId;
          },
          registerHandle: (h) => this.handles.set(jobId, h),
        });
        const cur = this.registry.get(projectId);
        if (!cur || cur.jobId !== jobId || cur.revision !== revision) {
          // A newer preview/edit superseded this one; drop the stale output.
          await fs.rm(result.video, { force: true }).catch(() => {});
          await fs.rm(result.manifest, { force: true }).catch(() => {});
          return;
        }
        cur.state = "done";
        cur.progress = 1;
        cur.url = `/api/preview/video/${projectId}/${revision}`;
        cur.videoFile = result.video;
        cur.manifestFile = result.manifest;
        cur.manifest = result.manifestDoc;
        cur.finishedAt = new Date().toISOString();
      } catch (e) {
        const cur = this.registry.get(projectId);
        if (cur && cur.jobId === jobId) {
          cur.state = e.cancelled ? "cancelled" : "failed";
          cur.error = e.message;
          cur.headroom = e.details || null;
        }
      } finally {
        this.handles.delete(jobId);
        await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
      }
    })();

    return this.registry.get(projectId);
  }

  fileFor(projectId, revision) {
    const cur = this.registry.get(projectId);
    if (!cur || cur.state !== "done" || String(cur.revision) !== String(revision)) {
      return null;
    }
    return { video: cur.videoFile, manifest: cur.manifestFile, manifestDoc: cur.manifest };
  }
}
