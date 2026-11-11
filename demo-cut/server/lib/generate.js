import path from "node:path";
import { runFFmpeg, probeMedia, countFrames } from "./ffmpeg.js";
import { toFFmpegSeconds, rat } from "./rational.js";

// Synthetic test media. Every frame carries:
//   - an SMPTE color bars background (recognizable bars region)
//   - a material id band (distinct base color per media)
//   - a 10-bit binary frame counter drawn with drawbox (no drawtext in this
//     static FFmpeg build), machine readable in verification
//   - a periodic 1 kHz sync beep (0.1 s) aligned to a known frame, so audio and
//     picture positions can be checked against each other.
//
// Filter args use exact integer frame indices; durations are rational seconds
// rendered to a decimal string only at the FFmpeg boundary.

const W = 320;
const H = 180;
const BITS = 10;
const BOX = 12;
const ROW_Y = H - 24;
const ROW_X = 8;
const BAND_H = 26;

// Distinct band color per material index (RGB hex for drawbox).
const BAND_COLORS = ["0x2e7d32", "0x6a1b9a", "0x0277bd", "0xef6c00", "0xc62828", "0x00838f"];

function bitFilters(frames) {
  const parts = [];
  for (let b = 0; b < BITS; b++) {
    const x = ROW_X + b * (BOX + 4);
    // Background slot always drawn dark first; a white box on top means bit=1.
    parts.push(`drawbox=x=${x}:y=${ROW_Y}:w=${BOX}:h=${BOX}:color=0x101010@1:t=fill`);
    const onFrames = [];
    for (let f = 0; f < Number(frames); f++) {
      if ((f >> b) & 1) onFrames.push(f);
    }
    if (onFrames.length) {
      const expr = onFrames.map((f) => `eq(n\\,${f})`).join("+");
      parts.push(
        `drawbox=x=${x}:y=${ROW_Y}:w=${BOX}:h=${BOX}:color=white@1:t=fill:enable='${expr}'`,
      );
    }
  }
  return parts;
}

// Generate one media file.
// opts: { id, index, frames, fps:{num,den}, sampleRate, beepEvery, beepAtFrame,
//         includeAudio, silentBars }
export async function generateMedia(destDir, opts) {
  const { id, index, frames, fps, sampleRate = 48000, beepEvery = 10,
    includeAudio = true } = opts;
  const dur = rat(frames * fps.den, fps.num);
  const durStr = toFFmpegSeconds(dur);
  const band = BAND_COLORS[index % BAND_COLORS.length];
  const dest = path.join(destDir, `${id}.mp4`);

  const vChain = [
    `smptebars=size=${W}x${H}:rate=${fps.num}/${fps.den}:duration=${durStr}`,
    `drawbox=x=0:y=0:w=${W}:h=${BAND_H}:color=${band}@1:t=fill`,
    ...bitFilters(frames),
    "format=yuv420p",
  ];

  const args = ["-f", "lavfi", "-i", vChain.join(",")];

  if (includeAudio) {
    // Continuous 1 kHz tone gated by one periodic expression: convert time to
    // the source frame index, and open the gate while that index modulo the
    // beep period is below the beep length (an integer number of frames). A
    // single modulo avoids stacking between() windows whose shared boundaries
    // extend each beep.
    const beepFrames = opts.beepFrames ?? Math.max(1, Math.floor(Number(fps.num) / Number(fps.den) / 10));
    const rate = toFFmpegSeconds(rat(fps.num, fps.den)); // frames per second
    const gate = `lt(mod(t*${rate},${beepEvery}),${beepFrames})`;
    const tone = `aevalsrc=0.6*sin(2*PI*1000*t):s=${sampleRate}:d=${durStr}`;
    args.push("-f", "lavfi", "-i", tone,
      "-af", `volume='if(${gate},1,0)':eval=frame`,
      "-map", "0:v", "-map", "1:a",
      "-c:a", "aac", "-ar", String(sampleRate), "-ac", "2", "-b:a", "96k");
  }

  args.push("-r", `${fps.num}/${fps.den}`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", dest);

  const handle = runFFmpeg(args, { totalSeconds: Number(durStr) || 1 });
  await handle.done;

  const info = await probeMedia(dest);
  const measured = await countFrames(dest);
  return {
    id,
    name: opts.name || id,
    path: dest,
    width: info.width,
    height: info.height,
    // The generated file is authored at the requested exact rational rate;
    // keep that value rather than a decimal banner approximation.
    fps: { num: fps.num, den: fps.den },
    frames: BigInt(measured || frames),
    sampleRate: info.sampleRate || sampleRate,
    audioChannels: includeAudio ? 2 : 0,
    beepEvery,
    kind: "synthetic",
    bandColor: band,
  };
}

export const MEDIA_GEOMETRY = { width: W, height: H, bits: BITS };
