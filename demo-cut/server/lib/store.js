import { promises as fs } from "node:fs";
import path from "node:path";
import { reviveProject, serializeProject, validateProject } from "./timeline.js";

// File-backed project store. Documents are immutable per revision: each save
// bumps revision and writes a new revision file, so a running render that froze
// its input can never observe a later edit.
export class ProjectStore {
  constructor(rootDir) {
    this.root = rootDir;
    this.dir = path.join(rootDir, "projects");
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
  }

  _file(id, revision) {
    return path.join(this.dir, `${id}.rev${revision}.json`);
  }

  async list() {
    const files = await fs.readdir(this.dir);
    const latest = new Map();
    for (const f of files) {
      const m = f.match(/^(.+)\.rev(\d+)\.json$/);
      if (!m) continue;
      const [, id, rev] = m;
      if (!latest.has(id) || Number(rev) > latest.get(id).rev) {
        latest.set(id, { id, rev: Number(rev), file: f });
      }
    }
    const items = [];
    for (const { id, rev } of latest.values()) {
      const raw = JSON.parse(await fs.readFile(path.join(this.dir, latest.get(id).file), "utf8"));
      items.push({
        id, revision: rev, name: raw.name, updatedAt: raw.updatedAt,
        clips: raw.clips.length, outputFps: `${raw.output.fps.num}/${raw.output.fps.den}`,
      });
    }
    return items.sort((a, b) => b.revision - a.revision);
  }

  // Save a new revision. Returns the frozen, revived project.
  async save(project) {
    validateProject(project);
    const revision = (project.revision || 0) + 1;
    project.revision = revision;
    project.updatedAt = new Date().toISOString();
    const doc = { ...project };
    await fs.writeFile(this._file(project.id, revision), serializeProject(doc));
    // Pointer file always names the newest good revision.
    await fs.writeFile(
      path.join(this.dir, `${project.id}.json`),
      JSON.stringify({ id: project.id, revision }, null, 2),
    );
    return this.load(project.id);
  }

  async load(id, revision = null) {
    let rev = revision;
    if (rev === null) {
      const ptr = JSON.parse(await fs.readFile(path.join(this.dir, `${id}.json`), "utf8"));
      rev = ptr.revision;
    }
    const raw = JSON.parse(await fs.readFile(this._file(id, rev), "utf8"));
    const project = reviveProject(raw);
    project.revision = rev;
    return project;
  }

  async revisions(id) {
    const files = await fs.readdir(this.dir);
    return files
      .filter((f) => f.startsWith(`${id}.rev`) && f.endsWith(".json"))
      .map((f) => Number(f.match(/\.rev(\d+)\.json$/)[1]))
      .sort((a, b) => a - b);
  }
}
