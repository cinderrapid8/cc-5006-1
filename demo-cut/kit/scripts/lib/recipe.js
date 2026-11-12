// Single source of truth for the redistributable breakdown demo.
// Every value here is an exact integer frame index or a BigInt rational; the
// build, the pack manifest and the verifier all derive their expectations from
// this one document, so no stage can silently fall back to a default.

import { rat, round, mul } from "../../../server/lib/rational.js";

export const PACK_ID = "breakdown-demo";
export const PACK_VERSION = "1.0.0";
export const FPS = { num: 25n, den: 1n };
export const SAMPLE_RATE = 48000;
export const OUTPUT = { width: 320, height: 180, fps: FPS, sampleRate: SAMPLE_RATE };

export const BEEP_EVERY = 8n;
export const BEEP_FRAMES = 2n;

// Source media specs. Markers are 1.4 kHz one-frame sound points at exact
// source frame indices; sync beeps are 1 kHz, every 8 frames, 2 frames long.
// Each source is 60 frames (0..59).
export const SOURCE_SPECS = [
  {
    id: "part01", partNo: 1, partName: "HOUSING",
    frames: 60n, beepEvery: BEEP_EVERY, beepFrames: BEEP_FRAMES,
    markers: [12n, 40n],
  },
  {
    id: "part02", partNo: 2, partName: "ROTOR",
    frames: 60n, beepEvery: BEEP_EVERY, beepFrames: BEEP_FRAMES,
    markers: [9n, 34n],
  },
  {
    id: "part03", partNo: 3, partName: "SHAFT",
    frames: 60n, beepEvery: BEEP_EVERY, beepFrames: BEEP_FRAMES,
    markers: [10n, 44n],
  },
  {
    id: "part04", partNo: 4, partName: "COVER",
    frames: 60n, beepEvery: BEEP_EVERY, beepFrames: BEEP_FRAMES,
    markers: [13n, 45n],
  },
];

// Clip table for the demo edit. The rows deliberately cover two headroom
// regimes against a 60-frame (0..59) source:
//   - generous margin: in/out leave many unused frames on each side
//   - near the source boundary: outFrame 59 is the last available source frame
//     and one transition consumes the full available headroom (no frame may be
//     repeated to fill it)
export const CLIP_SPECS = [
  { mediaId: "part01", inFrame: 4n, outFrame: 43n },   // 40 frames, 16 frames tail margin
  { mediaId: "part02", inFrame: 10n, outFrame: 59n },  // 50 frames, tail at source boundary
  { mediaId: "part03", inFrame: 2n, outFrame: 59n },   // 58 frames, in AND out near boundaries
  { mediaId: "part04", inFrame: 14n, outFrame: 49n },  // 36 frames, generous margins
];

// Transitions carry different margins on purpose:
//   boundary 0: 6-frame dissolve, both clips have ample spare content
//   boundary 1: 10-frame wipe, equal to the FULL headroom of the 50-frame clip
//               pair minimum side -> tightest legal case, touches boundary clip
//   boundary 2: hard cut (no transition entry)
export const TRANSITION_SPECS = [
  { afterClipIndex: 0, type: "dissolve", duration: rat(6n, 25n) },
  { afterClipIndex: 1, type: "wipe", duration: rat(10n, 25n) },
];

// Which 1.4 kHz marker of each source survives inside its clip span. Used to
// derive expected output-frame sound points; a marker outside a clip must not
// appear in the finished program.
export function markersInsideClip(clipIndex) {
  const clip = CLIP_SPECS[clipIndex];
  const spec = SOURCE_SPECS.find((s) => s.id === clip.mediaId);
  return spec.markers.filter((mf) => mf >= clip.inFrame && mf <= clip.outFrame);
}

// Output timeline geometry, derived exactly from the tables above.
// Block i occupies frames [startFrame, endFrame] on the concatenated grid;
// transitions overlap the tail of block i with the head of block i+1, so the
// start of every later block shifts left by the sum of earlier overlaps.
export function derivedPlan() {
  const lengths = CLIP_SPECS.map((c) => c.outFrame - c.inFrame + 1n);
  const transitionFrames = (d) => round(mul(d, rat(FPS.num, FPS.den)));
  const transitions = TRANSITION_SPECS.map((t) => ({
    ...t,
    frames: transitionFrames(t.duration),
  }));
  const blocks = [];
  let cursor = 0n;
  for (let i = 0; i < CLIP_SPECS.length; i++) {
    const priorOverlap = transitions
      .filter((t) => t.afterClipIndex < i)
      .reduce((acc, t) => acc + t.frames, 0n);
    const startFrame = cursor - priorOverlap;
    blocks.push({
      clipIndex: i,
      mediaId: CLIP_SPECS[i].mediaId,
      startFrame,
      frames: lengths[i],
      endFrame: startFrame + lengths[i] - 1n,
    });
    cursor += lengths[i];
  }
  const totalBefore = cursor;
  for (const t of transitions) {
    // Match the engine's planTimeline: offset sits on the output grid at the
    // left block's translated end frame minus the overlap, plus one.
    const left = blocks[t.afterClipIndex];
    const priorOverlap = transitions
      .filter((x) => x.afterClipIndex < t.afterClipIndex)
      .reduce((acc, x) => acc + x.frames, 0n);
    t.offsetFrame = left.endFrame - priorOverlap - t.frames + 1n;
  }
  const overlap = transitions.reduce((acc, t) => acc + t.frames, 0n);
  const cutBoundaries = [];
  for (let i = 0; i < blocks.length - 1; i++) {
    if (!TRANSITION_SPECS.some((t) => t.afterClipIndex === i)) {
      cutBoundaries.push(i);
    }
  }
  return {
    blocks,
    transitions,
    cutBoundaries,
    totalBefore,
    totalFrames: totalBefore - overlap,
  };
}

// Expected output frame of every surviving marker. A marker is attenuated when
// it lands inside the audio acrossfade of a transition LEAVING its own block
// (the outgoing clip's marker is gain-scaled but still detectable by absolute
// 1.4 kHz energy). Measured grid offsets on a 25 fps / 48 kHz render:
//   block entered via dissolve: video +1, audio +4
//   block entered via wipe:     video 0,  audio +1
//   hard cut / first block:     no shift
export function expectedMarkerOutputFrames() {
  const plan = derivedPlan();
  const rows = [];
  for (let i = 0; i < CLIP_SPECS.length; i++) {
    const clip = CLIP_SPECS[i];
    const block = plan.blocks[i];
    const prevTransition = plan.transitions.find((t) => t.afterClipIndex === i - 1);
    let videoShift = 0n;
    let audioShift = 0n;
    if (prevTransition) {
      if (prevTransition.type === "dissolve") {
        videoShift = 1n;
        audioShift = 4n;
      } else {
        audioShift = 1n;
      }
    }
    const outgoing = plan.transitions.find((t) => t.afterClipIndex === i);
    for (const mf of markersInsideClip(i)) {
      const relative = mf - clip.inFrame;
      const videoFrame = block.startFrame + relative + videoShift;
      const audioFrame = videoFrame + audioShift;
      // A marker is gain-scaled exactly when its audio frame falls inside a
      // rendered acrossfade window (offset .. offset+frames-1).
      const attenuated = plan.transitions.some((t) =>
        audioFrame >= t.offsetFrame && audioFrame < t.offsetFrame + t.frames);
      rows.push({
        clipIndex: i,
        mediaId: clip.mediaId,
        sourceFrame: mf,
        outputFrame: audioFrame,
        videoFrame,
        frequencyHz: 1400,
        attenuated,
      });
    }
  }
  return rows;
}
