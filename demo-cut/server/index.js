import http from "node:http";
import { promises as fs, createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { ProjectStore } from "./lib/store.js";
import { JobManager } from "./lib/jobs.js";
import {
  createProject, validateProject, planTimeline, checkTransitions,
  transitionAllowedRange,
} from "./lib/timeline.js";
import { generateMedia } from "./lib/generate.js";
import { probeMedia } from "./lib/ffmpeg.js";
import { PreviewService } from "./lib/preview.js";
import { label } from "./lib/rational.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, "data");
const PUBLIC = path.join(ROOT, "public");

const MEDIA_DIR = path.join(DATA, "media");
const WORK_DIR = path.join(DATA, "work");
const FINAL_DIR = path.join(DATA, "final");
const PREVIEW_DIR = path.join(DATA, "preview");

const store = new ProjectStore(DATA);
const jobs = new JobManager({ store, roots: { work: WORK_DIR, final: FINAL_DIR } });
const previews = new PreviewService({
  previewDir: PREVIEW_DIR, finalRoot: FINAL_DIR, workRoot: WORK_DIR,
});

// Preview snapshots are keyed by project revision inside PreviewService; an
// older preview job finishing late cannot overwrite a newer revision.

async function ensureDirs() {
  for (const d of [DATA, MEDIA_DIR, WORK_DIR, FINAL_DIR, PREVIEW_DIR]) {
    await fs.mkdir(d, { recursive: true });
  }
  await store.init();
  await jobs.init();
  await previews.init();
}

function sendJson(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body, (_k, v) =>
    typeof v === "bigint" ? v.toString() : v));
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {});
      } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function mediaView(m) {
  return {
    id: m.id, name: m.name, path: path.basename(m.path),
    fps: `${m.fps.num}/${m.fps.den}`, frames: m.frames.toString(),
    width: m.width, height: m.height, sampleRate: m.sampleRate,
    audioChannels: m.audioChannels, beepEvery: m.beepEvery, kind: m.kind,
    bandColor: m.bandColor,
  };
}

function projectView(p) {
  const plan = (() => {
    try {
      const t = planTimeline(p);
      return {
        totalFrames: t.totalFrames.toString(),
        blocks: t.blocks.map((b) => ({
          clipIndex: b.clipIndex, startFrame: b.startFrame.toString(),
          frames: b.frames.toString(), endFrame: b.endFrame.toString(),
        })),
        transitions: t.transitions.map((tr) => ({
          afterClipIndex: tr.afterClipIndex, type: tr.type,
          frames: tr.frames.toString(), offsetFrame: tr.offsetFrame.toString(),
          duration: label(tr.duration),
        })),
      };
    } catch {
      return null;
    }
  })();
  return {
    id: p.id, name: p.name, revision: p.revision,
    output: {
      width: p.output.width, height: p.output.height,
      fps: `${p.output.fps.num}/${p.output.fps.den}`,
      sampleRate: p.output.sampleRate,
    },
    media: p.media.map(mediaView),
    clips: p.clips.map((c) => ({
      id: c.id, mediaId: c.mediaId,
      inFrame: c.inFrame.toString(), outFrame: c.outFrame.toString(),
      freeze: c.freeze ? {
        frame: c.freeze.frame.toString(),
        holdFrames: c.freeze.holdFrames.toString(),
      } : null,
    })),
    transitions: p.transitions.map((t) => ({
      afterClipIndex: t.afterClipIndex, type: t.type,
      duration: `${t.duration.n}/${t.duration.d}`,
      allowed: (() => {
        const r = transitionAllowedRange(p, t.afterClipIndex);
        return { maxFrames: r.maxFrames.toString(), maxDuration: label(r.maxDuration) };
      })(),
    })),
    headroomErrors: checkTransitions(p),
    plan,
    updatedAt: p.updatedAt,
  };
}

// Registered in-memory media library (also recorded inside each project doc).
const mediaLibrary = new Map();

async function registerMedia(meta) {
  mediaLibrary.set(meta.id, meta);
  return meta;
}

const routes = {
  // ---- media -----------------------------------------------------------
  "POST /api/media/generate": async (req, res) => {
    const body = await readBody(req);
    const fpsNum = BigInt(body.fpsNum ?? 25);
    const fpsDen = BigInt(body.fpsDen ?? 1);
    const frames = BigInt(body.frames ?? 40);
    const id = `m_${randomUUID().slice(0, 8)}`;
    const meta = await generateMedia(MEDIA_DIR, {
      id,
      index: mediaLibrary.size,
      frames,
      fps: { num: fpsNum, den: fpsDen },
      sampleRate: body.sampleRate ?? 48000,
      beepEvery: body.beepEvery ?? 10,
      includeAudio: body.includeAudio !== false,
    });
    meta.name = body.name || `Media ${mediaLibrary.size + 1} (${fpsNum}/${fpsDen}fps)`;
    await registerMedia(meta);
    sendJson(res, 200, mediaView(meta));
  },

  "POST /api/media/import": async (req, res) => {
    const body = await readBody(req);
    // Only files already placed in the media dir are accepted (no upload here).
    const file = path.join(MEDIA_DIR, path.basename(body.file || ""));
    await fs.access(file);
    const info = await probeMedia(file);
    const id = `m_${randomUUID().slice(0, 8)}`;
    const meta = await registerMedia({
      id, name: body.name || path.basename(file), path: file,
      width: info.width, height: info.height, fps: info.fps,
      frames: BigInt(info.nbFrames || 0), sampleRate: info.sampleRate,
      audioChannels: info.audioChannels, beepEvery: null, kind: "imported",
      bandColor: null,
    });
    sendJson(res, 200, mediaView(meta));
  },

  "GET /api/media": async (_req, res) => {
    sendJson(res, 200, [...mediaLibrary.values()].map(mediaView));
  },

  // ---- projects --------------------------------------------------------
  "POST /api/projects": async (req, res) => {
    const body = await readBody(req);
    const id = `p_${randomUUID().slice(0, 8)}`;
    const project = createProject({
      id,
      name: body.name || "New breakdown edit",
      output: {
        width: body.width || 320,
        height: body.height || 180,
        fps: { num: BigInt(body.fpsNum ?? 25), den: BigInt(body.fpsDen ?? 1) },
        sampleRate: body.sampleRate ?? 48000,
      },
    });
    project.createdAt = new Date().toISOString();
    const saved = await store.save(project);
    sendJson(res, 200, projectView(saved));
  },

  "GET /api/projects": async (_req, res) => {
    sendJson(res, 200, await store.list());
  },

  "GET /api/projects/:id": async (req, res, _b, params) => {
    const p = await store.load(params.id);
    sendJson(res, 200, projectView(p));
  },

  // Save an edited document. The body is validated and stored as a new
  // revision; the running render keeps its own frozen snapshot.
  "PUT /api/projects/:id": async (req, res, _b, params) => {
    const current = await store.load(params.id);
    const body = await readBody(req);
    const doc = {
      ...current,
      name: body.name ?? current.name,
      clips: (body.clips || []).map((c) => ({
        id: c.id || `c_${randomUUID().slice(0, 8)}`,
        mediaId: c.mediaId,
        inFrame: BigInt(c.inFrame),
        outFrame: BigInt(c.outFrame),
        freeze: c.freeze ? {
          frame: BigInt(c.freeze.frame),
          holdFrames: BigInt(c.freeze.holdFrames),
        } : null,
      })),
      transitions: (body.transitions || []).map((t) => ({
        afterClipIndex: Number(t.afterClipIndex),
        type: t.type,
        duration: { n: BigInt(t.durationN), d: BigInt(t.durationD || 1) },
      })),
      media: current.media,
    };
    validateProject(doc);
    const saved = await store.save(doc);
    sendJson(res, 200, projectView(saved));
  },

  // Attach existing library media into the project's own media table.
  "POST /api/projects/:id/media": async (req, res, _b, params) => {
    const body = await readBody(req);
    const p = await store.load(params.id);
    const meta = mediaLibrary.get(body.mediaId);
    if (!meta) return sendJson(res, 404, { error: "unknown media" });
    if (!p.media.some((m) => m.id === meta.id)) p.media.push({ ...meta });
    const saved = await store.save(p);
    sendJson(res, 200, projectView(saved));
  },

  "GET /api/projects/:id/range/:boundary": async (req, res, _b, params) => {
    const p = await store.load(params.id);
    const range = transitionAllowedRange(p, Number(params.boundary));
    sendJson(res, 200, {
      boundary: Number(params.boundary),
      minFrames: range.minFrames.toString(),
      maxFrames: range.maxFrames.toString(),
      maxDuration: label(range.maxDuration),
    });
  },

  // ---- render jobs -----------------------------------------------------
  "POST /api/projects/:id/render": async (req, res, _b, params) => {
    const p = await store.load(params.id);
    const errors = checkTransitions(p);
    if (errors.length) return sendJson(res, 409, { error: "headroom", details: errors });
    const status = await jobs.start(p);
    sendJson(res, 200, status);
  },

  "GET /api/projects/:id/jobs": async (req, res, _b, params) => {
    sendJson(res, 200, jobs.list(params.id));
  },

  "GET /api/jobs/:jobId": async (req, res, _b, params) => {
    const s = jobs.status(params.jobId);
    if (!s) return sendJson(res, 404, { error: "no such job" });
    sendJson(res, 200, s);
  },

  "POST /api/jobs/:jobId/cancel": async (req, res, _b, params) => {
    const ok = jobs.cancel(params.jobId);
    sendJson(res, ok ? 200 : 409, { cancelled: ok });
  },

  "GET /api/projects/:id/products": async (req, res, _b, params) => {
    const items = jobs.listProducts(params.id).map((e) => ({
      jobId: e.jobId,
      revision: e.revision,
      videoUrl: `/api/download/video/${path.basename(e.video)}`,
      manifestUrl: `/api/download/manifest/${path.basename(e.manifest)}`,
      manifest: e.manifestDoc,
      createdAt: e.createdAt,
    }));
    sendJson(res, 200, items);
  },

  // ---- preview ---------------------------------------------------------
  "POST /api/projects/:id/preview": async (req, res, _b, params) => {
    const p = await store.load(params.id);
    const errors = checkTransitions(p);
    if (errors.length) return sendJson(res, 409, { error: "headroom", details: errors });
    const state = await previews.render(p);
    sendJson(res, 200, state);
  },

  "GET /api/projects/:id/preview": async (req, res, _b, params) => {
    sendJson(res, 200, previews.status(params.id));
  },

  "GET /api/preview/video/:id/:revision": async (req, res, _b, params) => {
    const f = previews.fileFor(params.id, params.revision);
    if (!f) return sendJson(res, 404, { error: "preview not ready or superseded" });
    serveFile(res, f.video, "video/mp4");
  },

  "GET /api/preview/manifest/:id/:revision": async (req, res, _b, params) => {
    const f = previews.fileFor(params.id, params.revision);
    if (!f) return sendJson(res, 404, { error: "preview not ready or superseded" });
    sendJson(res, 200, f.manifestDoc);
  },

  // ---- downloads -------------------------------------------------------
  "GET /api/download/video/:file": async (req, res, _b, params) => {
    serveFile(res, path.join(FINAL_DIR, path.basename(params.file)), "video/mp4");
  },
  "GET /api/download/manifest/:file": async (req, res, _b, params) => {
    serveFile(res, path.join(FINAL_DIR, path.basename(params.file)), "application/json");
  },
};

function serveFile(res, file, type) {
  fs.access(file).then(() => {
    res.writeHead(200, { "content-type": type });
    createReadStream(file).pipe(res);
  }).catch(() => sendJson(res, 404, { error: "not found" }));
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function serveStatic(req, res, urlPath) {
  let rel = urlPath === "/" ? "/index.html" : urlPath;
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) return sendJson(res, 403, { error: "forbidden" });
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: "not found" });
  }
}

function matchRoute(method, urlPath) {
  // Explicit matches first, then :id style patterns.
  const patterns = Object.keys(routes);
  for (const route of patterns) {
    const [rm, rp] = route.split(" ");
    if (rm !== method) continue;
    const rParts = rp.split("/").filter(Boolean);
    const uParts = urlPath.split("/").filter(Boolean);
    if (rParts.length !== uParts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < rParts.length; i++) {
      if (rParts[i].startsWith(":")) params[rParts[i].slice(1)] = decodeURIComponent(uParts[i]);
      else if (rParts[i] !== uParts[i]) { ok = false; break; }
    }
    if (ok) return { handler: routes[route], params };
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (!url.pathname.startsWith("/api/")) return await serveStatic(req, res, url.pathname);
    const match = matchRoute(req.method, url.pathname);
    if (!match) return sendJson(res, 404, { error: "no route" });
    await match.handler(req, res, null, match.params);
  } catch (e) {
    sendJson(res, e.code === "HEADROOM" || e.code === "HEADROOM_MEASURED" ? 409 : 500, {
      error: e.message,
      code: e.code || null,
      details: e.details || null,
    });
  }
});

export async function start(port = 3000) {
  await ensureDirs();
  return new Promise((resolve) => {
    server.listen(port, () => resolve({ port, server, store, jobs }));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 3000);
  start(port).then(({ port: p }) => {
    console.log(`demo-cut listening on http://localhost:${p}`);
  });
}
