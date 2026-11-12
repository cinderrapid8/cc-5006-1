#!/usr/bin/env node
// Build the redistributable breakdown asset pack from scratch:
//   1. procedurally generate four source clips (part animation, ASS numbering
//      captions, 1 kHz sync beeps and 1.4 kHz marker sound points)
//   2. author the frame-exact edit project document (clips + transitions)
//   3. render the finished program through the production render engine
//   4. write provenance and SHA-256 hashes for every delivered file
// Usage: node kit/scripts/build-pack.js [packDir]
import { promises as fs } from "node:fs";
import path from "node:path";

import { generateBreakdownMedia } from "./lib/breakdown-generator.js";
import {
  PACK_ID, PACK_VERSION, FPS, SAMPLE_RATE, OUTPUT,
  SOURCE_SPECS, CLIP_SPECS, TRANSITION_SPECS, derivedPlan,
} from "./lib/recipe.js";
import {
  PACK_DIR, sha256File, ensureEmptyDir, stableJson,
} from "./lib/paths.js";
import { createProject, validateProject, planTimeline, serializeProject }
  from "../../server/lib/timeline.js";
import { renderProject } from "../../server/lib/render.js";

async function main() {
  const packDir = process.argv[2] ? path.resolve(process.argv[2]) : PACK_DIR;
  const mediaDir = path.join(packDir, "media");
  const subDir = path.join(packDir, "subtitles");
  const workDir = path.join(packDir, "build-work");
  const finalDir = path.join(packDir, "deliverables");
  await ensureEmptyDir(mediaDir);
  await ensureEmptyDir(subDir);
  await fs.rm(workDir, { recursive: true, force: true });
  await fs.rm(finalDir, { recursive: true, force: true });
  await fs.mkdir(workDir, { recursive: true });
  await fs.mkdir(finalDir, { recursive: true });

  // ---- 1. procedural sources ------------------------------------------------
  const media = [];
  for (const spec of SOURCE_SPECS) {
    process.stdout.write(`generating ${spec.id} (part ${spec.partNo}, ${spec.frames} frames)...\n`);
    const meta = await generateBreakdownMedia(mediaDir, subDir, {
      ...spec,
      fps: FPS,
      sampleRate: SAMPLE_RATE,
    });
    // Pack stores relocatable relative paths; rebuild resolves them against the
    // pack root instead of this machine's absolute directories.
    meta.path = `media/${path.basename(meta.path)}`;
    meta.subtitle = `subtitles/${path.basename(meta.subtitle)}`;
    media.push(meta);
  }

  // ---- 2. project document --------------------------------------------------
  const project = createProject({
    id: PACK_ID,
    name: "Product breakdown demo",
    output: { ...OUTPUT, fps: { num: FPS.num, den: FPS.den } },
  });
  project.media = media.map((m) => ({ ...m }));
  project.clips = CLIP_SPECS.map((c, i) => ({
    id: `clip_${i + 1}`,
    mediaId: c.mediaId,
    inFrame: c.inFrame,
    outFrame: c.outFrame,
    freeze: null,
  }));
  project.transitions = TRANSITION_SPECS.map((t) => ({ ...t }));
  project.provenance = {
    generator: "kit/scripts/lib/breakdown-generator.js",
    recipe: "kit/scripts/lib/recipe.js",
    packVersion: PACK_VERSION,
    sampleRate: SAMPLE_RATE,
    beep: { frequencyHz: 1000, everyFrames: SOURCE_SPECS[0].beepEvery.toString(),
      lengthFrames: SOURCE_SPECS[0].beepFrames.toString() },
    marker: { frequencyHz: 1400, lengthFrames: "1" },
    note: "All media is procedurally generated with integer-frame parameters; " +
      "see sources.json for per-file parameters and hashes.",
  };
  validateProject(project);
  const plan = planTimeline(project);
  const derived = derivedPlan();
  if (plan.totalFrames !== derived.totalFrames) {
    throw new Error(`recipe/engine plan mismatch: ${plan.totalFrames} vs ${derived.totalFrames}`);
  }

  // Resolve media to absolute paths for this local render (document keeps
  // relative, relocatable paths).
  const { reviveProject } = await import("../../server/lib/timeline.js");
  const frozen = reviveProject(JSON.parse(JSON.stringify(project,
    (_k, v) => (typeof v === "bigint" ? v.toString() : v))));
  frozen.media = frozen.media.map((m) => ({
    ...m,
    path: path.join(packDir, m.path),
    subtitle: path.join(packDir, m.subtitle),
  }));
  frozen.revision = 1;

  // ---- 3. production render -------------------------------------------------
  process.stdout.write(`rendering finished program (${plan.totalFrames} output frames)...\n`);
  const result = await renderProject({
    frozen,
    workDir,
    finalDir,
    jobId: "pack-build",
    emit: (ev) => {
      if (ev.phase === "clip") process.stdout.write(`  clip ${ev.index + 1}/${ev.of}\n`);
    },
    shouldCancel: () => false,
    registerHandle: () => {},
  });

  // Move render products to stable pack names.
  const finalVideo = path.join(finalDir, "breakdown-demo.mp4");
  const finalManifest = path.join(finalDir, "breakdown-demo.manifest.json");
  await fs.rename(result.video, finalVideo);
  await fs.rename(result.manifest, finalManifest);
  await fs.rm(workDir, { recursive: true, force: true });

  // ---- 4. provenance + hashes ----------------------------------------------
  const files = [];
  for (const dir of [mediaDir, subDir, finalDir]) {
    for (const name of await fs.readdir(dir)) {
      const abs = path.join(dir, name);
      const rel = path.relative(packDir, abs).split(path.sep).join("/");
      files.push({ path: rel, sha256: await sha256File(abs), bytes: (await fs.stat(abs)).size });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));

  const sourcesDoc = {
    packId: PACK_ID,
    packVersion: PACK_VERSION,
    generatedBy: "kit/scripts/build-pack.js",
    fps: `${FPS.num}/${FPS.den}`,
    sampleRate: SAMPLE_RATE,
    sources: SOURCE_SPECS.map((s) => ({
      id: s.id,
      partNo: s.partNo,
      partName: s.partName,
      frames: s.frames.toString(),
      markers: s.markers.map((m) => m.toString()),
      beepEvery: s.beepEvery.toString(),
      beepFrames: s.beepFrames.toString(),
      media: `media/${s.id}.mp4`,
      subtitles: `subtitles/${s.id}.ass`,
    })),
    clips: CLIP_SPECS.map((c) => ({ ...c,
      inFrame: c.inFrame.toString(), outFrame: c.outFrame.toString() })),
    transitions: TRANSITION_SPECS.map((t) => ({
      ...t, duration: `${t.duration.n}/${t.duration.d}`,
    })),
    plan: {
      totalFrames: plan.totalFrames.toString(),
      blocks: plan.blocks.map((b) => ({
        clipIndex: b.clipIndex,
        startFrame: b.startFrame.toString(),
        endFrame: b.endFrame.toString(),
        frames: b.frames.toString(),
      })),
      transitions: plan.transitions.map((t) => ({
        afterClipIndex: t.afterClipIndex,
        type: t.type,
        frames: t.frames.toString(),
        offsetFrame: t.offsetFrame.toString(),
      })),
    },
  };
  await fs.writeFile(path.join(packDir, "sources.json"), stableJson(sourcesDoc));
  await fs.writeFile(path.join(packDir, "project.json"), serializeProject(project));
  await fs.writeFile(path.join(packDir, "pack-manifest.json"), stableJson({
    packId: PACK_ID,
    packVersion: PACK_VERSION,
    createdAt: "deterministic",
    project: "project.json",
    sources: "sources.json",
    deliverables: {
      video: "deliverables/breakdown-demo.mp4",
      renderManifest: "deliverables/breakdown-demo.manifest.json",
    },
    files: [...files,
      { path: "project.json", sha256: await sha256File(path.join(packDir, "project.json")),
        bytes: (await fs.stat(path.join(packDir, "project.json"))).size },
      { path: "sources.json", sha256: await sha256File(path.join(packDir, "sources.json")),
        bytes: (await fs.stat(path.join(packDir, "sources.json"))).size },
    ].sort((a, b) => a.path.localeCompare(b.path)),
  }));

  process.stdout.write(`pack built at ${packDir}\n`);
  process.stdout.write(`  total output frames: ${plan.totalFrames}\n`);
  process.stdout.write(`  files: ${files.length + 2}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
