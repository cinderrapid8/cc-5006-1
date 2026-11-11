import { promises as fs } from "node:fs";
import path from "node:path";
import { runFFmpeg, countFrames, countAudioSamples, probeMedia } from "./ffmpeg.js";
import {
  planTimeline, checkTransitions, describeClipSource,
} from "./timeline.js";
import { rat, round, mul, toFFmpegSeconds, label } from "./rational.js";

const SR = (project) => Number(project.output.sampleRate);

function escPath(p) {
  return p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

// Cancellation context shared with the job manager.
function makeCtx({ shouldCancel, registerHandle }) {
  let active = null;
  registerHandle({
    cancel() { if (active) active.cancel(); },
  });
  return {
    check() {
      if (shouldCancel()) {
        const e = new Error("cancelled");
        e.cancelled = true;
        throw e;
      }
    },
    run(args, opts) {
      this.check();
      active = runFFmpeg(args, opts);
      return active;
    },
  };
}

function modelClipFrames(clip, media, outFps) {
  const span = clip.outFrame - clip.inFrame + 1n;
  const spanSec = rat(span * media.fps.den, media.fps.num);
  const converted = round(mul(spanSec, rat(outFps.num, outFps.den)));
  const hold = clip.freeze ? clip.freeze.holdFrames : 0n;
  return converted + hold;
}

// One normalized intermediate per clip. Integer frame trim -> output fps ->
// optional tpad clone of a real decoded frame for the freeze.
async function buildClipIntermediate({ project, block, workDir, index, onProgress, ctx }) {
  const { clip, media } = block;
  const outFps = project.output.fps;
  const inT = toFFmpegSeconds(rat(clip.inFrame * media.fps.den, media.fps.num));
  const outT = toFFmpegSeconds(rat((clip.outFrame + 1n) * media.fps.den, media.fps.num));
  const out = path.join(workDir, `clip${index}.mp4`);

  const vChain = [
    `trim=start=${inT}:end=${outT}`,
    "setpts=PTS-STARTPTS",
    `fps=${outFps.num}/${outFps.den}`,
    `scale=${project.output.width}:${project.output.height}:flags=bicubic`,
    "setsar=1",
  ];
  // This path is used when the held frame is the span's last frame (or there is
  // no tail after it), so tpad clones exactly the requested decoded frame.
  if (clip.freeze && clip.freeze.holdFrames > 0n && clip.freeze.frame === clip.outFrame) {
    vChain.push(`tpad=stop_mode=clone:stop=${clip.freeze.holdFrames.toString()}`);
  }

  const args = ["-i", media.path];
  const hasAudio = media.audioChannels > 0;
  if (hasAudio) {
    const sr = SR(project);
    const inSample = clip.inFrame * BigInt(media.sampleRate) * media.fps.den / media.fps.num;
    const outSample = (clip.outFrame + 1n) * BigInt(media.sampleRate) * media.fps.den / media.fps.num;
    const spanSamples = outSample - inSample;
    const holdSamples = clip.freeze
      ? clip.freeze.holdFrames * BigInt(sr) * outFps.den / outFps.num
      : 0n;
    const totalSamples = spanSamples + holdSamples;
    const aChain = [
      `atrim=start_sample=${inSample.toString()}:end_sample=${outSample.toString()}`,
      "asetpts=PTS-STARTPTS",
      `aresample=${sr}`,
    ];
    if (clip.freeze && clip.freeze.holdFrames > 0n && clip.freeze.frame === clip.outFrame) {
      aChain.push(`apad=pad_dur=${toFFmpegSeconds(rat(holdSamples, BigInt(sr)))}`);
    }
    aChain.push(`apad=whole_dur=${toFFmpegSeconds(rat(totalSamples, BigInt(sr)))}`);
    aChain.push(`atrim=end_sample=${totalSamples.toString()}`);
    args.push("-filter_complex",
      `[0:v]${vChain.join(",")}[v];[0:a]${aChain.join(",")}[a]`,
      "-map", "[v]", "-map", "[a]");
  } else {
    args.push("-filter_complex", `[0:v]${vChain.join(",")}[v]`, "-map", "[v]");
  }

  args.push("-r", `${outFps.num}/${outFps.den}`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "20");
  if (hasAudio) {
    args.push("-c:a", "aac", "-ar", String(SR(project)), "-ac", "2", "-b:a", "128k");
  }
  args.push(out);

  const modelFrames = modelClipFrames(clip, media, outFps);
  const estSec = Number(modelFrames * outFps.den) / Number(outFps.num);
  const handle = ctx.run(args, { totalSeconds: estSec || 1 });
  handle.on("progress", (f) => onProgress(index, f));
  await handle.done;
  ctx.check();

  const measuredFrames = BigInt(await countFrames(out));
  const audio = hasAudio ? await countAudioSamples(out) : { samples: 0, rate: SR(project) };
  return { file: out, measuredFrames, modelFrames, audio };
}

// Freeze on a frame that is NOT the span's last frame: render head (ending on
// the exact decoded freeze frame, then tpad clone) and tail separately, and
// concat. The held image is provably source frame freeze.frame.
async function buildFreezeIntermediate({ project, block, workDir, index, onProgress, ctx }) {
  const { clip, media } = block;
  const outFps = project.output.fps;
  const t = (frame) => toFFmpegSeconds(rat(frame * media.fps.den, media.fps.num));
  const head = path.join(workDir, `clip${index}_head.mp4`);
  const tail = path.join(workDir, `clip${index}_tail.mp4`);
  const list = path.join(workDir, `clip${index}_list.txt`);
  const out = path.join(workDir, `clip${index}.mp4`);
  const sr = SR(project);

  const common = [
    `fps=${outFps.num}/${outFps.den}`,
    `scale=${project.output.width}:${project.output.height}:flags=bicubic`,
    "setsar=1",
  ];
  const headV = [
    `trim=start=${t(clip.inFrame)}:end=${t(clip.freeze.frame + 1n)}`,
    "setpts=PTS-STARTPTS", ...common,
    `tpad=stop_mode=clone:stop=${clip.freeze.holdFrames.toString()}`,
  ];
  const tailStart = clip.freeze.frame + 1n;
  const tailV = [
    `trim=start=${t(tailStart)}:end=${t(clip.outFrame + 1n)}`,
    "setpts=PTS-STARTPTS", ...common,
  ];

  const holdSamples = clip.freeze.holdFrames * BigInt(sr) * outFps.den / outFps.num;
  const mkArgs = (chain, dest, startFrame, endFrame, extraSilenceSamples = 0n) => {
    const a = ["-i", media.path];
    if (media.audioChannels > 0) {
      const s0 = startFrame * BigInt(media.sampleRate) * media.fps.den / media.fps.num;
      const s1 = endFrame * BigInt(media.sampleRate) * media.fps.den / media.fps.num;
      const span = s1 - s0;
      const total = span + extraSilenceSamples;
      const ac = [
        `atrim=start_sample=${s0.toString()}:end_sample=${s1.toString()}`,
        "asetpts=PTS-STARTPTS", `aresample=${sr}`,
        // Pad silence so the head audio matches the tpad-cloned video length
        // (the held picture region stays silent rather than repeating audio).
        `apad=whole_dur=${toFFmpegSeconds(rat(total, BigInt(sr)))}`,
        `atrim=end_sample=${total.toString()}`,
      ];
      a.push("-filter_complex",
        `[0:v]${chain.join(",")}[v];[0:a]${ac.join(",")}[a]`,
        "-map", "[v]", "-map", "[a]",
        "-c:a", "aac", "-ar", String(sr), "-ac", "2", "-b:a", "128k");
    } else {
      a.push("-filter_complex", `[0:v]${chain.join(",")}[v]`, "-map", "[v]");
    }
    a.push("-r", `${outFps.num}/${outFps.den}`,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "20", dest);
    return a;
  };

  const h1 = ctx.run(
    mkArgs(headV, head, clip.inFrame, clip.freeze.frame + 1n, holdSamples),
    { totalSeconds: 2 });
  h1.on("progress", (f) => onProgress(index, f * 0.5));
  await h1.done;
  ctx.check();

  let tailInfo = null;
  if (tailStart <= clip.outFrame) {
    const h2 = ctx.run(mkArgs(tailV, tail, tailStart, clip.outFrame + 1n),
      { totalSeconds: 2 });
    h2.on("progress", (f) => onProgress(index, 0.5 + f * 0.5));
    await h2.done;
    ctx.check();
    tailInfo = tail;
  }

  await fs.writeFile(list,
    [`file '${escPath(head)}'`, tailInfo ? `file '${escPath(tailInfo)}'` : ""]
      .filter(Boolean).join("\n"));
  const hc = ctx.run(["-f", "concat", "-safe", "0", "-i", list,
    "-c", "copy", "-fflags", "+genpts", out], { totalSeconds: 2 });
  await hc.done;
  ctx.check();

  const measuredFrames = BigInt(await countFrames(out));
  const audio = media.audioChannels > 0
    ? await countAudioSamples(out)
    : { samples: 0, rate: sr };
  return { file: out, measuredFrames, modelFrames: modelClipFrames(clip, media, outFps), audio };
}

// Final assembly. Two explicit transition types map to xfade "fade" (dissolve)
// and "wiperight" (wipe); audio uses acrossfade. Hard cuts use concat.
// Offsets come from integer frame positions on the output grid, each converted
// to decimal text exactly once at the FFmpeg boundary.
async function assemble({ project, clips, transitions, totalFrames, dest, onProgress, ctx }) {
  // Single clip: re-encode but pin the exact frame count with a frame-based
  // trim so container duration rounding cannot add a trailing duplicate frame.
  if (clips.length === 1) {
    const c = clips[0];
    const args = ["-i", c.file,
      "-filter_complex", `[0:v]trim=end_frame=${totalFrames.toString()},setpts=PTS-STARTPTS[v]`,
      "-map", "[v]",
      "-r", `${project.output.fps.num}/${project.output.fps.den}`,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "20"];
    if (c.audio.samples > 0) {
      const sr = SR(project);
      const totalSamples = totalFrames * BigInt(sr) * project.output.fps.den / project.output.fps.num;
      args.push("-af", `atrim=end_sample=${totalSamples.toString()},asetpts=PTS-STARTPTS`,
        "-map", "0:a", "-c:a", "aac", "-ar", String(sr), "-ac", "2", "-b:a", "160k");
    }
    args.push(dest);
    const estSec = Number(totalFrames * project.output.fps.den) / Number(project.output.fps.num);
    const handle = ctx.run(args, { totalSeconds: estSec || 1 });
    handle.on("progress", (f) => onProgress("assemble", f));
    await handle.done;
    ctx.check();
    return [];
  }

  const args = [];
  for (const c of clips) args.push("-i", c.file);

  const fc = [];
  let vLabel = "0:v";
  let aLabel = null;
  const hasAudioAll = clips.every((c) => c.audio.samples > 0);
  if (hasAudioAll) aLabel = "0:a";

  let cumEnd = clips[0].measuredFrames;
  const points = [];
  for (let i = 0; i < clips.length - 1; i++) {
    const tr = transitions.find((x) => x.afterClipIndex === i);
    const next = clips[i + 1];
    if (!tr) {
      const outV = `vcat${i}`;
      if (hasAudioAll) {
        const outA = `acat${i}`;
        fc.push(`[${vLabel}][${i + 1}:v]concat=n=2:v=1:a=0[${outV}]`);
        fc.push(`[${aLabel}][${i + 1}:a]concat=n=2:v=0:a=1[${outA}]`);
        aLabel = outA;
      } else {
        fc.push(`[${vLabel}][${i + 1}:v]concat=n=2:v=1:a=0[${outV}]`);
      }
      vLabel = outV;
      points.push({ boundary: i, kind: "cut", atOutputFrame: cumEnd.toString() });
      cumEnd += next.measuredFrames;
      continue;
    }
    const durSec = rat(tr.frames * project.output.fps.den, project.output.fps.num);
    const durStr = toFFmpegSeconds(durSec);
    const offsetFrames = cumEnd - tr.frames;
    const offsetStr = toFFmpegSeconds(
      rat(offsetFrames * project.output.fps.den, project.output.fps.num));
    const outV = `vx${i}`;
    const xType = tr.type === "wipe" ? "wiperight" : "fade";
    if (hasAudioAll) {
      const outA = `ax${i}`;
      fc.push(`[${vLabel}][${i + 1}:v]xfade=transition=${xType}:duration=${durStr}:offset=${offsetStr}[${outV}]`);
      fc.push(`[${aLabel}][${i + 1}:a]acrossfade=d=${durStr}:c1=tri:c2=tri[${outA}]`);
      aLabel = outA;
    } else {
      fc.push(`[${vLabel}][${i + 1}:v]xfade=transition=${xType}:duration=${durStr}:offset=${offsetStr}[${outV}]`);
    }
    vLabel = outV;
    cumEnd = cumEnd + next.measuredFrames - tr.frames;
    points.push({
      boundary: i, kind: tr.type, frames: tr.frames.toString(),
      duration: label(durSec), offsetFrame: offsetFrames.toString(),
    });
  }

  args.push("-filter_complex", fc.join(";"), "-map", `[${vLabel}]`);
  if (hasAudioAll) args.push("-map", `[${aLabel}]`);
  args.push("-r", `${project.output.fps.num}/${project.output.fps.den}`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "20");
  if (hasAudioAll) {
    args.push("-c:a", "aac", "-ar", String(SR(project)), "-ac", "2", "-b:a", "160k");
  }
  args.push(dest);

  const estSec = Number(totalFrames * project.output.fps.den) / Number(project.output.fps.num);
  const handle = ctx.run(args, { totalSeconds: estSec || 1 });
  handle.on("progress", (f) => onProgress("assemble", f));
  await handle.done;
  ctx.check();
  return points;
}

// Main entry. `frozen` is the immutable snapshot captured at job start.
export async function renderProject(
  { frozen, workDir, finalDir, jobId, emit, shouldCancel = () => false, registerHandle = () => {} },
) {
  const ctx = makeCtx({ shouldCancel, registerHandle });
  await fs.mkdir(workDir, { recursive: true });
  await fs.mkdir(finalDir, { recursive: true });

  const headroomErrors = checkTransitions(frozen);
  if (headroomErrors.length) {
    const err = new Error("transition headroom insufficient");
    err.code = "HEADROOM";
    err.details = headroomErrors;
    throw err;
  }
  const plan = planTimeline(frozen);
  emit({ phase: "plan", totalFrames: plan.totalFrames.toString() });

  const built = [];
  for (let i = 0; i < plan.blocks.length; i++) {
    ctx.check();
    const block = plan.blocks[i];
    emit({ phase: "clip", index: i, of: plan.blocks.length });
    const onProgress = (idx, frac) =>
      emit({ phase: "clip-progress", index: idx, fraction: Number(frac.toFixed(4)) });
    const needSplit = block.clip.freeze && block.clip.freeze.holdFrames > 0n &&
      block.clip.freeze.frame !== block.clip.outFrame;
    const result = needSplit
      ? await buildFreezeIntermediate({ project: frozen, block, workDir, index: i, onProgress, ctx })
      : await buildClipIntermediate({ project: frozen, block, workDir, index: i, onProgress, ctx });

    const diff = result.measuredFrames - result.modelFrames;
    if (diff < -1n || diff > 1n) {
      throw new Error(`clip ${i} frame mismatch: model=${result.modelFrames} measured=${result.measuredFrames}`);
    }
    built.push({ ...result, block });
  }

  // Authoritative headroom check against measured intermediate frame counts.
  const measuredErrors = [];
  for (const t of plan.transitions) {
    const left = built[t.afterClipIndex];
    const right = built[t.afterClipIndex + 1];
    const cap = left.measuredFrames < right.measuredFrames
      ? left.measuredFrames : right.measuredFrames;
    if (t.frames > cap) {
      measuredErrors.push({
        afterClipIndex: t.afterClipIndex,
        requestedFrames: t.frames.toString(),
        measuredMaxFrames: cap.toString(),
        message: `measured headroom at boundary ${t.afterClipIndex} is ${cap} frames, transition needs ${t.frames}`,
      });
    }
  }
  if (measuredErrors.length) {
    const err = new Error("measured transition headroom insufficient");
    err.code = "HEADROOM_MEASURED";
    err.details = measuredErrors;
    throw err;
  }

  const staged = path.join(workDir, `_stage_${jobId}.mp4`);
  const points = await assemble({
    project: frozen,
    clips: built,
    transitions: plan.transitions,
    totalFrames: plan.totalFrames,
    dest: staged,
    onProgress: (phase, frac) => emit({ phase, fraction: Number(frac.toFixed(4)) }),
    ctx,
  });

  const actualFrames = BigInt(await countFrames(staged));
  if (actualFrames !== plan.totalFrames) {
    throw new Error(`output frame count drift: planned ${plan.totalFrames}, got ${actualFrames}`);
  }

  const manifest = {
    jobId,
    projectId: frozen.id,
    projectRevision: frozen.revision,
    outputFps: `${frozen.output.fps.num}/${frozen.output.fps.den}`,
    sampleRate: SR(frozen),
    plannedTotalFrames: plan.totalFrames.toString(),
    measuredTotalFrames: actualFrames.toString(),
    clips: built.map((b, i) => ({
      clipIndex: i,
      intermediateFrames: b.measuredFrames.toString(),
      modelFrames: b.modelFrames.toString(),
      source: describeClipSource(b.block.clip, b.block.media),
      audioSamples: b.audio.samples,
    })),
    cutsAndTransitions: points,
    note: "Freeze regions hold the named decoded source frame; transitions overlap real adjacent content; no edge frames are repeated to fill transitions.",
  };

  const finalBase = path.join(finalDir, `${frozen.id}_r${frozen.revision}_${jobId}`);
  const finalVideo = `${finalBase}.mp4`;
  const finalManifest = `${finalBase}.manifest.json`;
  await fs.rename(staged, finalVideo);
  await fs.writeFile(finalManifest, JSON.stringify(manifest, null, 2));

  for (const b of built) {
    await fs.rm(b.file, { force: true }).catch(() => {});
  }
  return { video: finalVideo, manifest: finalManifest, manifestDoc: manifest };
}

export { probeMedia };
