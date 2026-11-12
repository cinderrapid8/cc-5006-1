// End-to-end test for the redistributable breakdown kit.
// Covers the full happy path plus negative cases that must FAIL LOUDLY:
//   - a tampered media file breaks its SHA-256 check
//   - a missing pack file is rejected rather than regenerated silently
//   - a transition beyond measured headroom is refused by the render engine
// Run: node kit/test/e2e-kit.mjs
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { reviveProject, validateProject, checkTransitions }
  from "../../server/lib/timeline.js";
import { rat } from "../../server/lib/rational.js";
import { derivedPlan, expectedMarkerOutputFrames } from "../scripts/lib/recipe.js";
import { sha256File } from "../scripts/lib/paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..", "..");
const TMP = path.join(REPO, "kit", "test-tmp");
const PACK = path.join(TMP, "pack-copy");

let passed = 0;
let failed = 0;
const failures = [];
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; failures.push(msg); console.error(`  ✗ ${msg}`); }
}
async function rmrf(p) { await fs.rm(p, { recursive: true, force: true }); }
const node = process.execPath;
const run = (script, args = []) =>
  execFileSync(node, [path.join(REPO, "kit", "scripts", script), ...args],
    { cwd: REPO, encoding: "utf8" });
const runExpectFail = (script, args = []) => {
  try {
    execFileSync(node, [path.join(REPO, "kit", "scripts", script), ...args],
      { cwd: REPO, encoding: "utf8", stdio: "pipe" });
    return null;
  } catch (e) { return (e.stderr || e.stdout || e.message); }
};

async function main() {
  await rmrf(TMP);
  await fs.mkdir(path.join(PACK, "media"), { recursive: true });

  // 1. Build the pack into a fresh directory --------------------------------
  console.log("\n[1] 构建资产包（程序化素材 + 工程 + 成片 + 哈希清单）");
  run("build-pack.js", [PACK]);
  const manifest = JSON.parse(await fs.readFile(path.join(PACK, "pack-manifest.json"), "utf8"));
  assert(manifest.files.length >= 11, `清单登记 ${manifest.files.length} 个文件（含媒体/字幕/成片/工程）`);
  for (const f of manifest.files) {
    assert(await sha256File(path.join(PACK, f.path)) === f.sha256,
      `构建即对账: ${f.path}`);
  }

  // 2. Clean rebuild + full verification -------------------------------------
  console.log("\n[2] 干净目录重建并核验帧号/声音/转场证据");
  const rebuildOut = path.join(TMP, "rebuild");
  const verifyOut = run("verify-rebuild.js", [PACK, rebuildOut]);
  assert(/all \d+ verification checks passed/.test(verifyOut),
    `核验全通过: ${verifyOut.trim().split("\n")[0]}`);
  const report = JSON.parse(await fs.readFile(
    path.join(rebuildOut, "evidence", "verify-report.json"), "utf8"));
  assert(report.totalFrames === derivedPlan().totalFrames.toString(),
    `成片总帧数 ${report.totalFrames} 等于配方推导 ${derivedPlan().totalFrames}`);
  assert(report.transitionEvidence.some((t) => t.type === "dissolve"), "证据含叠化");
  assert(report.transitionEvidence.some((t) => t.type === "wipe"), "证据含划像");
  assert(report.transitionEvidence.some((t) => t.type === "cut"), "证据含硬切");
  const markers = expectedMarkerOutputFrames();
  const markerRows = report.markerEvidence.filter((m) => m.sourceFrame);
  assert(markerRows.length === markers.length && markerRows.every((m) => m.detected),
    `全部 ${markers.length} 个声音落点在约定成片帧号检出`);

  // 3. Negative: tampered media must fail hash verification ------------------
  console.log("\n[3] 负向：篡改/缺失资产必须显式失败，不接受默认值伪装");
  const mediaFile = path.join(PACK, "media", "part02.mp4");
  const original = await fs.readFile(mediaFile);
  await fs.appendFile(mediaFile, Buffer.from([0, 1, 2, 3]));
  const tamperErr = runExpectFail("verify-rebuild.js", [PACK, path.join(TMP, "rebuild-bad")]);
  assert(tamperErr && /hash media\/part02\.mp4/.test(tamperErr),
    "篡改 part02.mp4 后哈希核验失败并中止");
  await fs.writeFile(mediaFile, original); // restore
  assert(await sha256File(mediaFile) === manifest.files.find((f) => f.path === "media/part02.mp4").sha256,
    "恢复后哈希重新对账成功");

  await fs.rm(path.join(PACK, "subtitles", "part03.ass"), { force: true });
  const missingErr = runExpectFail("verify-rebuild.js", [PACK, path.join(TMP, "rebuild-missing")]);
  assert(missingErr && /missing pack file: subtitles\/part03\.ass/.test(missingErr),
    "缺失字幕文件被拒绝，不会静默跳过");

  // 4. Negative: headroom rejection through the production engine ------------
  console.log("\n[4] 负向：转场超出真实余量被引擎拒绝");
  const project = reviveProject(JSON.parse(await fs.readFile(path.join(PACK, "project.json"), "utf8")));
  project.media = project.media.map((m) => ({ ...m, path: path.join(PACK, m.path) }));
  const tight = JSON.parse(JSON.stringify(project,
    (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  const tightProject = reviveProject(tight);
  // The first clip is only 40 frames long, so a 50-frame dissolve exceeds its
  // real headroom and must be refused instead of repeating edge frames.
  tightProject.clips = tightProject.clips.slice(0, 2);
  tightProject.transitions = [{ afterClipIndex: 0, type: "dissolve", duration: rat(50n, 25n) }];
  validateProject(tightProject);
  const errors = checkTransitions(tightProject);
  assert(errors.length === 1 && BigInt(errors[0].allowed.maxFrames) < 50n,
    `50 帧转场超出余量被拦截（上限 ${errors[0]?.allowed.maxFrames}）`);

  // 5. Second editor continues from the shipped pack -------------------------
  console.log("\n[5] 第二位编辑从干净目录加载并续编（修订隔离 + 重渲染）");
  const editOut = path.join(TMP, "edit");
  const editLog = run("edit-continue.js", [PACK, editOut]);
  assert(/revision 2 rendered/.test(editLog), "续编产出修订 2 成片");
  const editReport = JSON.parse(await fs.readFile(path.join(editOut, "edit-report.json"), "utf8"));
  assert(editReport.measuredFrames === editReport.expectedFrames,
    `续编成片帧数 ${editReport.measuredFrames} 与工程推导一致`);
  assert(BigInt(editReport.markerTrace.sourceFrame) === 44n,
    "续编后 src44 声音/画面标记仍精确可追溯");
  const revisions = await fs.readdir(path.join(editOut, "projects"));
  assert(revisions.includes("breakdown-demo.rev1.json")
    && revisions.includes("breakdown-demo.rev2.json"),
    "修订 1/2 文件均落盘，历史不可变");

  await rmrf(TMP);
  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  if (failed) {
    console.error("失败项：\n - " + failures.join("\n - "));
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
