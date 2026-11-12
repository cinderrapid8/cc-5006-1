#!/usr/bin/env node
// Demonstrate that a second editor can load the shipped pack from a clean
// directory and keep editing. The script:
//   1. loads project.json from the pack (no local build artifacts required)
//   2. applies a documented change: tighten clip 3's out point and shrink the
//      wipe transition, then saves revision 2 through the ProjectStore
//   3. renders the revised program and re-verifies frame/sound evidence
// Usage: node kit/scripts/edit-continue.js [packDir] [workDir]
import { promises as fs } from "node:fs";
import path from "node:path";

import { countFrames } from "../../server/lib/ffmpeg.js";
import { extractRawFrames, readFrameCounter } from "../../server/lib/verify.js";
import { reviveProject, validateProject, checkTransitions, planTimeline }
  from "../../server/lib/timeline.js";
import { ProjectStore } from "../../server/lib/store.js";
import { renderProject } from "../../server/lib/render.js";
import { stableJson } from "./lib/paths.js";

async function main() {
  const packDir = process.argv[2] ? path.resolve(process.argv[2])
    : path.join(process.cwd(), "kit", "pack");
  const workDir = process.argv[3] ? path.resolve(process.argv[3])
    : path.join(process.cwd(), "kit", "edit-output");
  await fs.rm(workDir, { recursive: true, force: true });
  await fs.mkdir(workDir, { recursive: true });

  const project = reviveProject(JSON.parse(
    await fs.readFile(path.join(packDir, "project.json"), "utf8")));
  // Relocatable pack paths -> this machine's absolute paths.
  project.media = project.media.map((m) => ({
    ...m,
    path: path.join(packDir, m.path),
    subtitle: path.join(packDir, m.subtitle),
  }));

  const store = new ProjectStore(workDir);
  await store.init();
  const rev1 = await store.save(project);
  if (rev1.revision !== 1) throw new Error("expected first save to be revision 1");

  // Documented editorial change:
  //   - clip index 2 (part03): out 59 -> 47 (still includes its marker at 44)
  //   - wipe after clip 1: 10 frames -> 6 frames (kept inside measured
  //     headroom; the original 10-frame case remains in the pack's revision 1)
  const edited = await store.load(rev1.id);
  edited.clips[2].outFrame = 47n;
  const wipe = edited.transitions.find((t) => t.afterClipIndex === 1);
  wipe.duration = { n: 6n, d: 25n };
  validateProject(edited);
  const headroom = checkTransitions(edited);
  if (headroom.length) throw new Error(`edited project violates headroom: ${JSON.stringify(headroom)}`);
  const rev2 = await store.save(edited);
  if (rev2.revision !== 2) throw new Error("expected edited save to be revision 2");

  // Revision 1 stays immutable and re-renderable.
  const reopened1 = await store.load(rev1.id, 1);
  if (reopened1.clips[2].outFrame !== 59n) {
    throw new Error("revision 1 was mutated by the later edit");
  }

  const result = await renderProject({
    frozen: { ...rev2, revision: 2 },
    workDir: path.join(workDir, "work"),
    finalDir: path.join(workDir, "final"),
    jobId: "edit-r2",
    emit: () => {},
    shouldCancel: () => false,
    registerHandle: () => {},
  });

  // Expected total is derived from the edited project itself, never hard-coded:
  // 168 original - 12 removed clip frames + 4 overlap change (wipe 10 -> 6).
  const editedPlan = planTimeline(rev2);
  const expected = editedPlan.totalFrames;
  const measured = await countFrames(result.video);
  if (BigInt(measured) !== expected) {
    throw new Error(`edited render frame drift: measured ${measured}, expected ${expected}`);
  }

  // The part03 marker at source frame 44 must still trace exactly. Locate the
  // output frame whose burned counter decodes to source frame 44 by scanning
  // the rendered clip-2 region, instead of relying on a hand-derived offset.
  const { frames, width } = await extractRawFrames(result.video);
  const block2 = editedPlan.blocks.find((b) => b.clipIndex === 2);
  const priorOverlap = editedPlan.transitions
    .filter((t) => t.afterClipIndex < 2)
    .reduce((a, t) => a + t.frames, 0n);
  const searchStart = Number(block2.startFrame - priorOverlap);
  let markerOutputFrame = -1;
  for (let f = searchStart; f < frames.length; f++) {
    if (BigInt(readFrameCounter(frames[f], width)) === 44n) { markerOutputFrame = f; break; }
  }
  if (markerOutputFrame < 0) {
    throw new Error("edited marker trace failed: no output frame decodes to source 44");
  }
  const counter = readFrameCounter(frames[markerOutputFrame], width);

  await fs.writeFile(path.join(workDir, "edit-report.json"), stableJson({
    basePack: path.relative(process.cwd(), packDir),
    revision1: { clip2OutFrame: "59", wipeFrames: "10" },
    revision2: { clip2OutFrame: "47", wipeFrames: "6" },
    measuredFrames: measured.toString(),
    expectedFrames: expected.toString(),
    markerTrace: { outputFrame: markerOutputFrame, sourceFrame: counter },
    storeRevisions: await store.revisions(rev1.id),
  }));
  console.log(`edit-continue ok: revision 2 rendered, ${measured} frames (expected ${expected})`);
  console.log(`report: ${path.join(workDir, "edit-report.json")}`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
