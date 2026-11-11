import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import ffmpegStatic from "ffmpeg-static";

export const FFMPEG = ffmpegStatic;

// This environment ships an aarch64 ffmpeg-static but no matching ffprobe
// binary, so all probing goes through ffmpeg itself (stderr banner parse plus
// decode-based counting). Everything needed for frame-accurate work is
// available without ffprobe.
function spawnFFmpeg(args, { captureStdout = false } = {}) {
  return new Promise((resolve, reject) => {
    const out = [];
    const err = [];
    const p = spawn(FFMPEG, ["-hide_banner", ...args], {
      stdio: ["ignore", captureStdout ? "pipe" : "ignore", "pipe"],
    });
    if (captureStdout) p.stdout.on("data", (d) => out.push(d));
    p.stderr.on("data", (d) => err.push(d));
    p.on("error", reject);
    p.on("close", (code) => {
      const stderr = Buffer.concat(err).toString();
      // ffmpeg returns 1 when invoked with no output (plain -i probe); that is
      // expected and the banner still contains the stream metadata.
      resolve({ code, stdout: Buffer.concat(out).toString(), stderr });
    });
  });
}

function parseRate(rate) {
  const [n, d] = rate.split("/").map((x) => BigInt(x || "1"));
  return { num: n, den: d || 1n };
}

// Parse `ffmpeg -i file` stderr into stream metadata.
export async function probeMedia(file) {
  const { stderr } = await spawnFFmpeg(["-i", file]);
  const vLine = stderr.split(/\r?\n/).find((l) => l.includes("Video:"));
  const aLine = stderr.split(/\r?\n/).find((l) => l.includes("Audio:"));
  if (!vLine) throw new Error(`no video stream in ${file}`);

  const sizeM = vLine.match(/(\d{2,5})x(\d{2,5})/);
  const tbrM = vLine.match(/([0-9.]+)\s+tbr/);
  const fpsM = vLine.match(/([0-9.]+)\s+fps/);
  const pixM = vLine.match(/,\s*([a-z0-9_]+)(?:\s*\(|,)/);
  const durM = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);

  // Prefer the tbr rate (container time base rate, integer fraction style);
  // fall back to the fps decimal.
  let fps;
  if (tbrM && tbrM[1].includes(".")) {
    fps = decimalToRat(tbrM[1]);
  } else if (fpsM) {
    fps = decimalToRat(fpsM[1]);
  } else {
    fps = { num: 25n, den: 1n };
  }

  let sampleRate = null;
  let audioChannels = 0;
  if (aLine) {
    const sr = aLine.match(/,\s*(\d+)\s*Hz/);
    if (sr) sampleRate = Number(sr[1]);
    const ch = aLine.match(/,\s*(mono|stereo|([0-9.]+)\s*channels?)/);
    if (ch) audioChannels = ch[1] === "mono" ? 1 : ch[1] === "stereo" ? 2 : Number(ch[2]) || 2;
  }

  return {
    width: sizeM ? Number(sizeM[1]) : 0,
    height: sizeM ? Number(sizeM[2]) : 0,
    fps,
    pixFmt: pixM ? pixM[1] : "yuv420p",
    nbFrames: null, // filled by exact decode count below
    duration: durM
      ? Number(durM[1]) * 3600 + Number(durM[2]) * 60 + Number(durM[3])
      : null,
    sampleRate,
    audioChannels,
  };
}

// Convert a decimal rate string (e.g. "29.97") to an exact-ish BigInt rational
// using its decimal digits (30000/1001 style values come straight from tbn in
// generated files; this covers probe fallbacks).
function decimalToRat(s) {
  if (!s.includes(".")) return { num: BigInt(s), den: 1n };
  const [whole, frac] = s.split(".");
  const den = 10n ** BigInt(frac.length);
  return { num: BigInt(whole) * den + BigInt(frac), den };
}

export function runFFprobe(args) {
  // Kept for API compatibility; routes through ffmpeg where possible.
  return spawnFFmpeg(args, { captureStdout: true }).then((r) => r.stdout);
}

// Run ffmpeg with machine-readable progress on stdout.
// Returns an emitter: .on("progress", frac), .cancel(), .done promise.
export function runFFmpeg(args, { totalSeconds = null } = {}) {
  const emitter = new EventEmitter();
  const fullArgs = ["-nostdin", "-y", ...args, "-progress", "pipe:1", "-nostats"];
  const child = spawn(FFMPEG, fullArgs, { stdio: ["ignore", "pipe", "pipe"] });
  let stderrTail = "";
  let settled = false;
  let cancelled = false;

  child.stderr.on("data", (d) => {
    stderrTail = (stderrTail + d.toString()).slice(-4000);
  });
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    const m = text.match(/out_time_us=(\d+)/) || text.match(/out_time_ms=(\d+)/);
    if (m && totalSeconds && totalSeconds > 0) {
      const v = Number(m[1]);
      const micros = text.includes("out_time_us") ? v : v;
      const frac = Math.min(1, Math.max(0, micros / 1_000_000 / totalSeconds));
      emitter.emit("progress", frac);
    }
    if (/progress=end/.test(text)) emitter.emit("progress", 1);
  });

  const done = new Promise((resolve, reject) => {
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      reject(e);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (cancelled) {
        const err = new Error("cancelled");
        err.cancelled = true;
        reject(err);
      } else if (code === 0) {
        resolve({ code, stderr: stderrTail });
      } else {
        reject(new Error(`ffmpeg exited ${code}: ${stderrTail.slice(-1200)}`));
      }
    });
  });

  emitter.cancel = () => {
    if (settled || cancelled) return;
    cancelled = true;
    try { child.kill("SIGTERM"); } catch { /* noop */ }
    setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* noop */ } }, 2000);
  };
  emitter.done = done;
  return emitter;
}

// Exact frame count by decoding to null and parsing the banner's frame= count.
export async function countFrames(file) {
  const { stderr } = await spawnFFmpeg([
    "-i", file,
    "-map", "0:v:0",
    "-f", "null", "-",
  ]);
  const matches = [...stderr.matchAll(/frame=\s*(\d+)/g)];
  if (!matches.length) throw new Error(`could not count frames in ${file}`);
  return Number(matches[matches.length - 1][1]);
}

// Audio sample count via ffmpeg astats / packet decode. We decode to null with
// a signalstats-free approach: the banner reports size only, so instead use
// -af asetnsamples and parse read_interval via astats metadata. Simpler:
// derive from duration * sample rate using the full decode of s16le length.
export async function countAudioSamples(file) {
  const probe = await probeMedia(file);
  if (!probe.audioChannels) return { samples: 0, rate: probe.sampleRate || 0 };
  const { stdout, code } = await spawnFFmpeg([
    "-i", file,
    "-map", "0:a:0",
    "-ac", "1",
    "-f", "s16le",
    "pipe:1",
  ], { captureStdout: true });
  if (code !== 0) return { samples: 0, rate: probe.sampleRate || 0 };
  return { samples: stdout.length / 2, rate: probe.sampleRate || 0 };
}
