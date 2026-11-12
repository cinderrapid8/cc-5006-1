import path from "node:path";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const KIT_ROOT = path.join(__dirname, "..", "..");
export const PACK_DIR = path.join(KIT_ROOT, "pack");

export async function sha256File(file) {
  const h = createHash("sha256");
  const buf = await fs.readFile(file);
  h.update(buf);
  return h.digest("hex");
}

export async function ensureEmptyDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
}

// JSON with deterministic key ordering is not required for correctness, but a
// stable byte layout keeps the pack manifest diff-friendly in git.
export function stableJson(obj) {
  return JSON.stringify(obj, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
}
