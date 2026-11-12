import path from "node:path";
import { runFFmpeg, probeMedia, countFrames } from "../../../server/lib/ffmpeg.js";
import { rat, toFFmpegSeconds } from "../../../server/lib/rational.js";

// Procedural "product breakdown" source generator.
//
// Every decoded frame carries machine-readable evidence, so every later cut and
// transition can be traced back to an exact source frame:
//   - top band: per-part color + a row of white part-id boxes (count = partNo)
//   - middle: an animated part block that slides across the frame every frame
//     (its x position is a deterministic function of the source frame index)
//   - bottom: a 10-bit binary source-frame counter drawn with drawbox (the same
//     encoding read back by server/lib/verify.js)
//   - subtitles: an ASS file with the part number caption, burned in via libass
//     (this static FFmpeg build has no drawtext)
// Audio is fully procedural too:
//   - 1000 Hz sync beeps every beepEvery frames, beepFrames long
//   - distinct 1400 Hz one-frame markers at explicitly named anchor frames
//     (the audio "sound points" used to verify the edit downstream)

export const GEOM = {
  width: 320,
  height: 180,
  bits: 10,
  box: 12,
  counterX: 8,
  counterY: 180 - 24,
  bandH: 26,
  partBox: 10,
  partBoxGap: 4,
  partBoxX: 8,
  partBoxY: 8,
  partBlockH: 28,
  partBlockY: 62,
  slideMargin: 12,
};

export const PART_COLORS = ["0x2e7d32", "0x6a1b9a", "0x0277bd", "0xef6c00"];

function frameCounterFilters(frames) {
  const filters = [];
  for (let b = 0; b < GEOM.bits; b++) {
    const x = GEOM.counterX + b * (GEOM.box + 4);
    filters.push(`drawbox=x=${x}:y=${GEOM.counterY}:w=${GEOM.box}:h=${GEOM.box}:color=0x101010@1:t=fill`);
    const onFrames = [];
    for (let f = 0; f < Number(frames); f++) {
      if ((f >> b) & 1) onFrames.push(f);
    }
    if (onFrames.length) {
      const expr = onFrames.map((f) => `eq(n\\,${f})`).join("+");
      filters.push(
        `drawbox=x=${x}:y=${GEOM.counterY}:w=${GEOM.box}:h=${GEOM.box}:color=white@1:t=fill:enable='${expr}'`,
      );
    }
  }
  return filters;
}

function partIdFilters(partNo, frames) {
  // partNo white boxes in the band; enable each box for the whole clip so part
  // identity is machine-readable from any frame without OCR.
  const filters = [];
  const all = [];
  for (let f = 0; f < Number(frames); f++) all.push(`eq(n\\,${f})`);
  for (let k = 0; k < partNo; k++) {
    const x = GEOM.partBoxX + k * (GEOM.partBox + GEOM.partBoxGap);
    filters.push(
      `drawbox=x=${x}:y=${GEOM.partBoxY}:w=${GEOM.partBox}:h=${GEOM.partBox}:color=white@1:t=fill:enable='${all.join("+")}'`,
    );
  }
  return filters;
}

// This static FFmpeg build cannot evaluate time variables (t/n) inside drawbox
// position expressions, so the sliding part block is one constant-position
// drawbox per possible x, each enabled on exactly the frames where the block's
// deterministic left edge equals that x. Position stays a pure function of the
// source frame index: left(n) = margin + (n*7 mod range).
function slidingBlockFilters(frames) {
  const slideRange = GEOM.width - GEOM.slideMargin * 2 - 36;
  const byX = new Map();
  for (let f = 0; f < Number(frames); f++) {
    const x = GEOM.slideMargin + (f * 7) % slideRange;
    if (!byX.has(x)) byX.set(x, []);
    byX.get(x).push(f);
  }
  return [...byX.entries()].map(([x, onFrames]) => {
    const expr = onFrames.map((f) => `eq(n\\,${f})`).join("+");
    return `drawbox=x=${x}:y=${GEOM.partBlockY}:w=36:h=${GEOM.partBlockH}:color=white@0.92:t=fill:enable='${expr}'`;
  });
}

// ASS caption document. Times are converted from exact frame indices; the same
// document is shipped in the pack and drives the burned-in subtitles.
export function assDocument({ fps, frames, partNo, partName }) {
  const hdr = `[Script Info]
ScriptType: v4.00+
PlayResX: ${GEOM.width}
PlayResY: ${GEOM.height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: PartCaption,DejaVu Sans,18,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,3,2,0,8,8,8,30,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const ts = (frame) => {
    const r = rat(frame * fps.den, fps.num);
    const total = r.n / r.d;
    const h = total / 3600n;
    const m = (total % 3600n) / 60n;
    const s = total % 60n;
    const cs = (r.n % r.d) * 100n / r.d;
    const pad = (v, w = 2) => v.toString().padStart(w, "0");
    return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(cs)}`;
  };
  const text = `PART ${partNo} - ${partName}`.replace(/,/g, " ");
  const line = `Dialogue: 0,${ts(0n)},${ts(frames)},PartCaption,,0,0,0,,${text}\n`;
  return hdr + line;
}

function escFilterPath(p) {
  return p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

// Generate one breakdown source media plus its standalone ASS subtitle.
// spec: {
//   id, partNo, partName, frames, fps:{num,den}, sampleRate,
//   beepEvery, beepFrames, markers: [frameIndex...], bandColor
// }
export async function generateBreakdownMedia(destDir, subtitleDir, spec) {
  const {
    id, partNo, partName, frames, fps, sampleRate = 48000,
    beepEvery, beepFrames, markers,
  } = spec;
  const band = spec.bandColor || PART_COLORS[(partNo - 1) % PART_COLORS.length];
  const dur = rat(frames * fps.den, fps.num);
  const durStr = toFFmpegSeconds(dur);
  const rateStr = toFFmpegSeconds(rat(fps.num, fps.den));
  const dest = path.join(destDir, `${id}.mp4`);
  const assPath = path.join(subtitleDir, `${id}.ass`);
  await import("node:fs/promises").then((fs) =>
    fs.writeFile(assPath, assDocument({ fps, frames, partNo, partName })));

  const slideRange = GEOM.width - GEOM.slideMargin * 2 - 36;
  const vChain = [
    `color=c=0x14181f:size=${GEOM.width}x${GEOM.height}:rate=${fps.num}/${fps.den}:duration=${durStr}`,
    `drawbox=x=0:y=0:w=${GEOM.width}:h=${GEOM.bandH}:color=${band}@1:t=fill`,
    ...partIdFilters(partNo, frames),
    // Sliding part block, materialized as per-frame enabled constant boxes
    // (this build rejects time variables in drawbox positions).
    ...slidingBlockFilters(frames),
    ...frameCounterFilters(frames),
    `ass='${escFilterPath(assPath)}'`,
    "format=yuv420p",
  ];

  const args = ["-f", "lavfi", "-i", vChain.join(",")];

  // Audio bed: periodic 1 kHz sync beeps plus one-frame 1.4 kHz markers. Two
  // aevalsrc streams are amix-ed; each gate is an exact frame-index expression.
  const syncGate = `lt(mod(t*${rateStr},${beepEvery}),${beepFrames})`;
  const markerTerms = markers.map((mf) => `eq(floor(t*${rateStr}),${mf})`).join("+");
  const syncSrc = `aevalsrc=0.5*sin(2*PI*1000*t):s=${sampleRate}:d=${durStr}`;
  const markerSrc = `aevalsrc=0.55*sin(2*PI*1400*t):s=${sampleRate}:d=${durStr}`;
  args.push(
    "-f", "lavfi", "-i", syncSrc,
    "-f", "lavfi", "-i", markerSrc,
    "-filter_complex",
    `[1:a]volume='if(${syncGate},1,0)':eval=frame[s];` +
    `[2:a]volume='if(${markerTerms},1,0)':eval=frame[m];` +
    `[s][m]amix=inputs=2:normalize=0,atrim=end_sample=${(frames * BigInt(sampleRate) * fps.den / fps.num).toString()}[a]`,
    "-map", "0:v", "-map", "[a]",
    "-c:a", "aac", "-ar", String(sampleRate), "-ac", "2", "-b:a", "96k",
  );

  args.push("-r", `${fps.num}/${fps.den}`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", dest);

  const handle = runFFmpeg(args, { totalSeconds: Number(durStr) || 1 });
  await handle.done;

  const info = await probeMedia(dest);
  const measured = await countFrames(dest);
  if (BigInt(measured) !== frames) {
    throw new Error(`${id}: generated ${measured} frames, spec required ${frames}`);
  }
  return {
    id,
    partNo,
    partName,
    path: dest,
    subtitle: assPath,
    width: info.width,
    height: info.height,
    fps: { num: BigInt(fps.num), den: BigInt(fps.den) },
    frames: frames,
    sampleRate: info.sampleRate || sampleRate,
    audioChannels: 2,
    beepEvery,
    beepFrames,
    markers: markers.map((x) => BigInt(x)),
    bandColor: band,
    kind: "breakdown",
  };
}

// Read the expected part-id box count back out of a decoded RGB frame.
export function readPartId(frame, width = GEOM.width) {
  let count = 0;
  for (let k = 0; k < 9; k++) {
    const x = GEOM.partBoxX + k * (GEOM.partBox + GEOM.partBoxGap) + Math.floor(GEOM.partBox / 2);
    const y = GEOM.partBoxY + Math.floor(GEOM.partBox / 2);
    const i = (y * width + x) * 3;
    if (frame[i] > 200 && frame[i + 1] > 200 && frame[i + 2] > 200) count++;
    else break;
  }
  return count;
}

// Expected center-x of the sliding block for a source frame index. The
// drawbox position expression sets the LEFT edge to margin + (frame*7 mod
// range), so the center adds half the 36px block width.
export function expectedBlockX(frameIndex) {
  const slideRange = GEOM.width - GEOM.slideMargin * 2 - 36;
  const left = GEOM.slideMargin + (Number(frameIndex) * 7) % slideRange;
  return left + 18;
}
