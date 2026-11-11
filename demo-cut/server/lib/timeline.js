import {
  rat, mul, floor, round, toFFmpegSeconds, label, ZERO,
} from "./rational.js";

// Project document (persisted to disk as JSON):
// {
//   version, id, name,
//   output: { width, height, fps: {num, den}, sampleRate },
//   media: { id, path, fps:{num,den}, frames, width, height, sampleRate,
//            audioChannels, hasBars, beepEvery, kind }[],
//   clips: [{ id, mediaId, inFrame, outFrame, freeze: {frame, holdFrames}|null }],
//   transitions: [{ afterClipIndex, type: "dissolve"|"wipe", duration:{n,d} }]
// }
// Every temporal value is integer frames or a BigInt rational; no float seconds
// are ever stored.

export const TRANSITION_TYPES = ["dissolve", "wipe"];

export function createProject({ id, name, output }) {
  return {
    version: 1,
    id,
    name: name || "Untitled",
    output: {
      width: output.width,
      height: output.height,
      fps: { num: BigInt(output.fps.num), den: BigInt(output.fps.den) },
      sampleRate: output.sampleRate,
    },
    media: [],
    clips: [],
    transitions: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

// Revive BigInts and validate structure of a parsed project.
export function reviveProject(raw) {
  const assert = (cond, msg) => { if (!cond) throw new Error(`invalid project: ${msg}`); };
  assert(raw && raw.version === 1, "unsupported version");
  assert(raw.output && raw.output.fps, "missing output fps");
  const p = JSON.parse(JSON.stringify(raw));
  p.output.fps = { num: BigInt(p.output.fps.num), den: BigInt(p.output.fps.den) };
  for (const m of p.media) {
    m.fps = { num: BigInt(m.fps.num), den: BigInt(m.fps.den) };
    m.frames = BigInt(m.frames);
  }
  for (const t of p.transitions) {
    t.duration = { n: BigInt(t.duration.n), d: BigInt(t.duration.d) };
  }
  for (const c of p.clips) {
    c.inFrame = BigInt(c.inFrame);
    c.outFrame = BigInt(c.outFrame);
    if (c.freeze) {
      c.freeze.frame = BigInt(c.freeze.frame);
      c.freeze.holdFrames = BigInt(c.freeze.holdFrames);
    }
  }
  validateProject(p);
  return p;
}

// Plain JSON serialization (BigInt -> string tokens that reviveProject reads).
export function serializeProject(p) {
  return JSON.stringify(p, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
}

export function validateProject(p) {
  const assert = (cond, msg) => { if (!cond) throw new Error(`invalid project: ${msg}`); };
  assert(p.output.fps.den > 0n, "output fps denominator must be positive");
  const mediaById = new Map();
  for (const m of p.media) {
    assert(m.fps.den > 0n && m.fps.num > 0n, "media fps must be positive");
    assert(m.frames > 0n, "media must have frames");
    mediaById.set(m.id, m);
  }
  for (let i = 0; i < p.clips.length; i++) {
    const c = p.clips[i];
    const m = mediaById.get(c.mediaId);
    assert(m, `clip ${i} references missing media`);
    assert(c.inFrame >= 0n && c.outFrame < m.frames, `clip ${i} in/out outside media`);
    assert(c.outFrame >= c.inFrame, `clip ${i} out before in`);
    if (c.freeze) {
      assert(c.freeze.frame >= c.inFrame && c.freeze.frame <= c.outFrame,
        `clip ${i} freeze frame outside in/out`);
      assert(c.freeze.holdFrames >= 0n, `clip ${i} negative freeze hold`);
    }
  }
  for (const t of p.transitions) {
    assert(TRANSITION_TYPES.includes(t.type), `unknown transition ${t.type}`);
    assert(t.duration.d > 0n && t.duration.n > 0n, "transition duration must be positive");
    assert(Number.isInteger(t.afterClipIndex) &&
      t.afterClipIndex >= 0 && t.afterClipIndex < p.clips.length - 1,
      "transition must sit between two adjacent clips");
  }
  const seen = new Set();
  for (const t of p.transitions) {
    assert(!seen.has(t.afterClipIndex), "duplicate transition on same boundary");
    seen.add(t.afterClipIndex);
  }
}

// Duration in output frames contributed by one clip before transitions.
// Source span is converted to the output rate with deterministic rounding, then
// the freeze hold (already counted in output frames) is added.
export function clipOutputFrames(clip, media, outFps) {
  const spanFrames = clip.outFrame - clip.inFrame + 1n;
  const spanSec = rat(spanFrames * media.fps.den, media.fps.num);
  const converted = round(mul(spanSec, rat(outFps.num, outFps.den)));
  const hold = clip.freeze ? clip.freeze.holdFrames : 0n;
  return converted + hold;
}

// Conservative lower bound of frames a clip can contribute to a transition on
// the given side without any edge-frame repetition. The real count is measured
// after the per-clip intermediate is rendered; this is used for pre-checks and
// for reporting an allowed range in the UI.
export function clipMinAvailableFrames(clip, media, outFps, side) {
  const spanFrames = clip.outFrame - clip.inFrame + 1n;
  const spanSec = rat(spanFrames * media.fps.den, media.fps.num);
  const total = floor(mul(spanSec, rat(outFps.num, outFps.den)));
  const hold = clip.freeze ? clip.freeze.holdFrames : 0n;
  if (side === "left") {
    // Right side content available to a dissolve into the next clip.
    if (clip.freeze) return total + hold; // freeze tail is real decoded frames
    return total;
  }
  // Left edge content available to a dissolve from the previous clip.
  return total;
}

// Allowed transition length range (in output frames) for boundary i:
// 1 .. min(headroomLeft, headroomRight), plus the max as rational seconds.
export function transitionAllowedRange(project, afterClipIndex) {
  const { clips, media, output } = project;
  const byId = new Map(media.map((m) => [m.id, m]));
  const left = clips[afterClipIndex];
  const right = clips[afterClipIndex + 1];
  if (!left || !right) return { minFrames: 0n, maxFrames: 0n, maxDuration: ZERO };
  const lm = byId.get(left.mediaId);
  const rm = byId.get(right.mediaId);
  const lAvail = clipMinAvailableFrames(left, lm, output.fps, "left");
  const rAvail = clipMinAvailableFrames(right, rm, output.fps, "right");
  const maxFrames = lAvail < rAvail ? lAvail : rAvail;
  const maxDuration = rat(maxFrames * output.fps.den, output.fps.num);
  return { minFrames: 1n, maxFrames, maxDuration };
}

// Check every transition against clip headroom. Returns a structured error with
// the exact allowed range instead of silently repeating edge frames.
export function checkTransitions(project) {
  const errors = [];
  for (const t of project.transitions) {
    const range = transitionAllowedRange(project, t.afterClipIndex);
    const wantFrames = round(mul(t.duration, rat(project.output.fps.num, project.output.fps.den)));
    if (wantFrames > range.maxFrames) {
      errors.push({
        afterClipIndex: t.afterClipIndex,
        type: t.type,
        requestedFrames: wantFrames,
        allowed: {
          minFrames: range.minFrames,
          maxFrames: range.maxFrames,
          maxDuration: range.maxDuration,
          maxDurationLabel: label(range.maxDuration),
        },
        message: `transition after clip #${t.afterClipIndex} needs ${wantFrames} frames but only ` +
          `${range.maxFrames} are available without repeating edge frames; choose 1..${range.maxFrames} ` +
          `frames (max ${label(range.maxDuration)}) or extend the clips' in/out points`,
      });
    }
  }
  return errors;
}

// Planned timeline (exact). Returns clip blocks with output-frame positions and
// the transition table. Positions are integers on the output frame grid, so the
// final total is an exact sum — no running float seconds anywhere.
export function planTimeline(project) {
  const byId = new Map(project.media.map((m) => [m.id, m]));
  const blocks = [];
  let cursor = 0n;
  for (let i = 0; i < project.clips.length; i++) {
    const clip = project.clips[i];
    const media = byId.get(clip.mediaId);
    const frames = clipOutputFrames(clip, media, project.output.fps);
    blocks.push({
      clipIndex: i,
      clip,
      media,
      startFrame: cursor,
      frames,
      endFrame: cursor + frames - 1n,
    });
    cursor += frames;
  }
  const transitions = project.transitions.map((t) => {
    const left = blocks[t.afterClipIndex];
    const right = blocks[t.afterClipIndex + 1];
    const frames = round(mul(t.duration, rat(project.output.fps.num, project.output.fps.den)));
    return {
      ...t,
      frames,
      offsetFrame: left.endFrame - frames + 1n, // start frame of overlap on output grid
    };
  });
  const totalBefore = cursor;
  const overlapTotal = transitions.reduce((acc, t) => acc + t.frames, 0n);
  const totalFrames = totalBefore - overlapTotal;
  return { blocks, transitions, totalFrames, totalBefore };
}

// Source position description used by preview labels and the export manifest.
// For a freeze region it reports the actual decoded source frame being held.
export function describeClipSource(clip, media) {
  const base = {
    mediaId: media.id,
    mediaName: media.name || media.id,
    sourceFps: `${media.fps.num}/${media.fps.den}`,
    inFrame: clip.inFrame.toString(),
    outFrame: clip.outFrame.toString(),
  };
  if (clip.freeze) {
    base.freeze = {
      sourceFrame: clip.freeze.frame.toString(),
      holdFrames: clip.freeze.holdFrames.toString(),
      note: `output holds decoded source frame #${clip.freeze.frame} for ${clip.freeze.holdFrames} output frames`,
    };
  }
  return base;
}

export { rat, toFFmpegSeconds, label };
