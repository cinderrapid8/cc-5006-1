// Exact rational time arithmetic on BigInt.
// A Rational is { n: bigint, d: bigint } with d > 0 (not necessarily reduced).
// Every timeline position and duration is expressed as a rational number of
// seconds. Frame indices stay integers. Floating point is only ever used when
// handing a value to FFmpeg as a string, never accumulated along the timeline.

const ZERO = { n: 0n, d: 1n };

export function rat(n, d = 1n) {
  if (d === 0n) throw new Error("rational with zero denominator");
  if (d < 0n) { n = -n; d = -d; }
  return { n: BigInt(n), d: BigInt(d) };
}

export function fromInt(i) {
  return { n: BigInt(i), d: 1n };
}

// Parse "num/den" or an integer string. Never accept float tokens.
export function parseRat(s) {
  const parts = String(s).split("/");
  if (parts.some((p) => p.includes(".") || p.includes("e"))) {
    throw new Error(`refuse to parse approximate token as rational: ${s}`);
  }
  if (parts.length === 1) return rat(BigInt(parts[0]));
  if (parts.length === 2) return rat(BigInt(parts[0]), BigInt(parts[1]));
  throw new Error(`bad rational: ${s}`);
}

function gcd(a, b) {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) { [a, b] = [b, a % b]; }
  return a || 1n;
}

export function reduce(r) {
  const g = gcd(r.n, r.d);
  return { n: r.n / g, d: r.d / g };
}

export function add(a, b) {
  return { n: a.n * b.d + b.n * a.d, d: a.d * b.d };
}

export function sub(a, b) {
  return { n: a.n * b.d - b.n * a.d, d: a.d * b.d };
}

export function mul(a, b) {
  return { n: a.n * b.n, d: a.d * b.d };
}

// Multiply a rational by an integer frame rate fraction: r * (fn/fd)
export function mulFrame(r, fn, fd) {
  return { n: r.n * BigInt(fn), d: r.d * BigInt(fd) };
}

export function cmp(a, b) {
  const l = a.n * b.d;
  const r = b.n * a.d;
  return l === r ? 0 : l < r ? -1 : 1;
}

export function isNeg(r) { return r.n < 0n; }
export function isZero(r) { return r.n === 0n; }
export function eq(a, b) { return cmp(a, b) === 0; }

// Exact rounding helpers used at the single FFmpeg boundary only.
export function floor(r) {
  const q = r.n / r.d;
  return r.n < 0n && r.n % r.d !== 0n ? q - 1n : q;
}

export function ceil(r) {
  const q = r.n / r.d;
  return r.n > 0n && r.n % r.d !== 0n ? q + 1n : q;
}

// Nearest integer, halves round up.
export function round(r) {
  const half = { n: r.d, d: r.d * 2n };
  return floor(add(r, half));
}

// Convert rational seconds to an output-timeline frame index/round count
// at output rate fn/fd using deterministic rounding rules.
export function framesAt(r, fn, fd, mode = "round") {
  const x = mulFrame(r, fn, fd);
  return mode === "floor" ? floor(x) : mode === "ceil" ? ceil(x) : round(x);
}

// A high precision decimal string for FFmpeg filter args. This is the only
// place seconds become floating text, and it is never fed back into the model.
export function toFFmpegSeconds(r, digits = 9) {
  r = reduce(r);
  const neg = r.n < 0n;
  const n = neg ? -r.n : r.n;
  const whole = n / r.d;
  let rem = n % r.d;
  let frac = "";
  for (let i = 0; i < digits && rem > 0n; i++) {
    rem *= 10n;
    frac += (rem / r.d).toString();
    rem %= r.d;
  }
  while (frac.length < 3) frac += "0";
  return `${neg ? "-" : ""}${whole.toString()}.${frac}`;
}

// Human readable rational, e.g. "12/25 s" plus reduced form.
export function label(r) {
  const red = reduce(r);
  return red.d === 1n ? `${red.n}s` : `${red.n}/${red.d}s`;
}

export { ZERO };
