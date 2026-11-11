import path from "node:path";
import { spawn } from "node:child_process";
import { FFMPEG, countFrames, countAudioSamples } from "./ffmpeg.js";

// Frame-accurate verification helpers. All frame extraction goes through raw
// RGB output so the binary frame-counter boxes drawn by the generator can be
// read back pixel by pixel, and SMPTE bars / material bands can be identified.

const GEOM = { width: 320, height: 180, bits: 10, box: 12, rowX: 8, rowY: 180 - 24, bandH: 26 };

export async function extractRawFrames(file, { width, height } = { width: 320, height: 180 }) {
  const args = [
    "-i", file,
    "-vf", `scale=${width}:${height}`,
    "-pix_fmt", "rgb24",
    "-f", "rawvideo",
    "pipe:1",
  ];
  const chunks = [];
  await new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ["-hide_banner", "-nostdin", "-loglevel", "error", ...args],
      { stdio: ["ignore", "pipe", "pipe"] });
    p.stdout.on("data", (d) => chunks.push(d));
    let err = "";
    p.stderr.on("data", (d) => { err += d.toString(); });
    p.on("close", (code) => code === 0 ? resolve() : reject(new Error(err)));
  });
  const buf = Buffer.concat(chunks);
  const frameSize = width * height * 3;
  const frames = [];
  for (let off = 0; off + frameSize <= buf.length; off += frameSize) {
    frames.push(buf.subarray(off, off + frameSize));
  }
  return { frames, width, height };
}

function pixel(frame, w, x, y) {
  const i = (y * w + x) * 3;
  return [frame[i], frame[i + 1], frame[i + 2]];
}

function isWhite([r, g, b]) { return r > 200 && g > 200 && b > 200; }
function isDark([r, g, b]) { return r < 60 && g < 60 && b < 60; }

// Read the 10-bit counter drawn in a frame. Returns integer frame number.
export function readFrameCounter(frame, width = 320) {
  let value = 0;
  for (let b = 0; b < GEOM.bits; b++) {
    const x = GEOM.rowX + b * (GEOM.box + 4) + Math.floor(GEOM.box / 2);
    const y = GEOM.rowY + Math.floor(GEOM.box / 2);
    const px = pixel(frame, width, x, y);
    if (isWhite(px)) value |= 1 << b;
  }
  return value;
}

// Detect which material band color dominates the top band. The counter boxes
// occupy the bottom rows, so the top band is clean; sample its right half to
// stay clear of every generated marker.
export function readBandColor(frame, width = 320) {
  const samples = [];
  const x0 = Math.floor(width * 0.6);
  for (let x = x0; x < width - 4; x += 8) {
    samples.push(pixel(frame, width, x, 10));
  }
  const avg = samples.reduce((acc, [r, g, b]) => {
    acc[0] += r; acc[1] += g; acc[2] += b; return acc;
  }, [0, 0, 0]).map((v) => Math.round(v / samples.length));
  return avg;
}

// SMPTE bars presence: look for the characteristic vertical bar transitions in
// the middle region (below the band, above the counter).
export function hasColorBars(frame, width = 320, height = 180) {
  const y = Math.floor(height * 0.55);
  let transitions = 0;
  let prev = pixel(frame, width, 2, y);
  for (let x = 6; x < width - 2; x += 4) {
    const cur = pixel(frame, width, x, y);
    const d = Math.abs(cur[0] - prev[0]) + Math.abs(cur[1] - prev[1]) + Math.abs(cur[2] - prev[2]);
    if (d > 180) transitions++;
    prev = cur;
  }
  return transitions >= 4;
}

// Decode audio to raw PCM s16le mono and compute per-window RMS to locate beeps.
export async function extractAudioLevels(file, sampleRate = 48000, windowMs = 20) {
  const chunks = [];
  await new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, [
      "-hide_banner", "-nostdin", "-loglevel", "error",
      "-i", file,
      "-ac", "1", "-ar", String(sampleRate),
      "-f", "s16le", "pipe:1",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    p.stdout.on("data", (d) => chunks.push(d));
    let err = "";
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err))));
  });
  const buf = Buffer.concat(chunks);
  const win = Math.floor(sampleRate * windowMs / 1000);
  const windows = [];
  for (let off = 0; off + 2 <= buf.length; off += win * 2) {
    let sumSq = 0;
    let n = 0;
    const end = Math.min(off + win * 2, buf.length - 1);
    for (let i = off; i + 1 < end; i += 2) {
      const s = buf.readInt16LE(i);
      sumSq += s * s;
      n++;
    }
    windows.push(n ? Math.sqrt(sumSq / n) : 0);
  }
  return { windows, windowMs, sampleRate };
}

// Windows whose RMS exceeds a threshold are "loud" (inside a beep).
export function findLoudWindows(levels, threshold = 4000) {
  const idx = [];
  levels.windows.forEach((v, i) => { if (v > threshold) idx.push(i); });
  return idx;
}

export function loudRanges(levels, threshold = 4000) {
  const loud = findLoudWindows(levels, threshold);
  if (!loud.length) return [];
  const ranges = [];
  let start = loud[0];
  let prev = loud[0];
  for (let i = 1; i < loud.length; i++) {
    if (loud[i] > prev + 1) {
      ranges.push([start, prev]);
      start = loud[i];
    }
    prev = loud[i];
  }
  ranges.push([start, prev]);
  return ranges.map(([a, b]) => ({
    startMs: a * levels.windowMs,
    endMs: (b + 1) * levels.windowMs,
    midMs: ((a + b + 1) / 2) * levels.windowMs,
  }));
}

export async function probeFrames(file) {
  return countFrames(file);
}

export async function probeAudio(file) {
  return countAudioSamples(file);
}

// Compare colors within tolerance.
export function colorClose(a, b, tol = 40) {
  return Math.abs(a[0] - b[0]) <= tol &&
    Math.abs(a[1] - b[1]) <= tol &&
    Math.abs(a[2] - b[2]) <= tol;
}

export function hexToRgb(hex) {
  const n = parseInt(hex.replace("0x", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export { GEOM };
