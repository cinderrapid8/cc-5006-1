import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generateMedia } from "../server/lib/generate.js";
import {
  createProject, validateProject, planTimeline, checkTransitions,
  transitionAllowedRange, reviveProject, serializeProject,
} from "../server/lib/timeline.js";
import { renderProject } from "../server/lib/render.js";
import { ProjectStore } from "../server/lib/store.js";
import {
  extractRawFrames, readFrameCounter, readBandColor, hasColorBars,
  extractAudioLevels, loudRanges, probeFrames, probeAudio, colorClose,
  hexToRgb,
} from "../server/lib/verify.js";
import { add, rat, toFFmpegSeconds } from "../server/lib/rational.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(__dirname, "..", "data", "test-tmp");

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; failures.push(msg); console.error(`  ✗ ${msg}`); }
}
function assertEq(actual, expected, msg) {
  const ok = actual === expected || (BigInt(actual) === BigInt(expected));
  assert(ok, `${msg} (期望 ${expected}, 实际 ${actual})`);
}

async function rmrf(p) { await fs.rm(p, { recursive: true, force: true }); }

function makeProject(id, outFps, sampleRate = 48000) {
  return createProject({
    id, name: id,
    output: { width: 320, height: 180, fps: outFps, sampleRate },
  });
}

function addClip(p, media, inFrame, outFrame, freeze = null) {
  if (!p.media.some((m) => m.id === media.id)) p.media.push({ ...media });
  p.clips.push({
    id: `c_${p.clips.length}_${Math.random().toString(36).slice(2, 7)}`,
    mediaId: media.id,
    inFrame: BigInt(inFrame),
    outFrame: BigInt(outFrame),
    freeze,
  });
}

async function render(p, label) {
  const workDir = path.join(TMP, `work_${label}_${Date.now()}`);
  const finalDir = path.join(TMP, "final");
  const result = await renderProject({
    frozen: p, workDir, finalDir, jobId: `j_${label}`,
    emit: () => {}, shouldCancel: () => false, registerHandle: () => {},
  });
  return result;
}

// ---------------------------------------------------------------------------
async function testRational() {
  console.log("\n[1] 有理数时间：无浮点累加");
  // 300 additions of 1/25 must equal 12 exactly, not 11.99999...
  let acc = rat(0n);
  for (let i = 0; i < 300; i++) acc = add(acc, rat(1n, 25n));
  assertEq(acc.n / acc.d, 12n, "300 × 1/25s 精确等于 12s");
  assert(toFFmpegSeconds(rat(1n, 3n)).startsWith("0.333333333"), "有理秒仅在 FFmpeg 边界转十进制字符串");
}

// ---------------------------------------------------------------------------
async function testShortClipHardCuts(mediaSet) {
  console.log("\n[2] 短片段 + 硬切：总帧数与切换点");
  const p = makeProject("t_short", { num: 25n, den: 1n });
  // 8-frame, 6-frame and 4-frame clips at 25fps source -> exact output frames.
  addClip(p, mediaSet.m25a, 0, 7);
  addClip(p, mediaSet.m25b, 2, 7);
  addClip(p, mediaSet.m25c, 0, 3);
  validateProject(p);
  const plan = planTimeline(p);
  assertEq(plan.totalFrames, 8n + 6n + 4n, "计划总帧数 = 8+6+4 = 18");

  const { video, manifestDoc } = await render(p, "short");
  const actual = await probeFrames(video);
  assertEq(actual, 18, "导出实测总帧数 18，无尾部漂移");

  const { frames, width } = await extractRawFrames(video);
  assertEq(frames.length, 18, "解码得到 18 个原始帧");

  // Cut points at output frame 8 and 14.
  const bandA = hexToRgb(mediaSet.m25a.bandColor);
  const bandB = hexToRgb(mediaSet.m25b.bandColor);
  const bandC = hexToRgb(mediaSet.m25c.bandColor);
  assert(colorClose(readBandColor(frames[0], width), bandA), "帧0 属于素材A（色带识别）");
  assert(colorClose(readBandColor(frames[7], width), bandA), "帧7 仍属于素材A");
  assert(colorClose(readBandColor(frames[8], width), bandB), "帧8 硬切到素材B");
  assert(colorClose(readBandColor(frames[13], width), bandB), "帧13 仍属于素材B");
  assert(colorClose(readBandColor(frames[14], width), bandC), "帧14 硬切到素材C");
  assert(colorClose(readBandColor(frames[17], width), bandC), "帧17 属于素材C");

  // Frame counters map to exact source frame indices.
  assertEq(readFrameCounter(frames[0], width), 0, "帧0 的二进制计数器读出源帧0");
  assertEq(readFrameCounter(frames[8], width), 2, "帧8 读出素材B源帧2");
  assert(hasColorBars(frames[4], width), "中段帧保留 SMPTE 彩条");
  assertEq(manifestDoc.measuredTotalFrames, "18", "清单记录实测总帧数");
}

// ---------------------------------------------------------------------------
async function testMixedFps(mediaSet) {
  console.log("\n[3] 混合帧率：帧率分别保存、输出网格精确");
  const p = makeProject("t_mixed", { num: 25n, den: 1n });
  addClip(p, mediaSet.m24, 0, 23);       // 24fps, 24 frames = 1s
  addClip(p, mediaSet.m30, 0, 29);       // 30fps, 30 frames = 1s
  addClip(p, mediaSet.m2997, 0, 31);     // 30000/1001 fps, 32 frames
  validateProject(p);
  const plan = planTimeline(p);

  const c0 = plan.blocks[0];
  const c1 = plan.blocks[1];
  assertEq(c0.frames, 25n, "24fps 的 1 秒内容映射为 25 个输出帧");
  assertEq(c1.frames, 25n, "30fps 的 1 秒内容映射为 25 个输出帧");

  const { video } = await render(p, "mixed");
  const actual = await probeFrames(video);
  assertEq(actual, plan.totalFrames, `混合帧率实测总帧数等于计划值 ${plan.totalFrames}`);

  const { frames, width } = await extractRawFrames(video);
  // First block: source 24fps frame 23 lands near output frame 24.
  const lastFirstBlock = frames[Number(c0.frames) - 1];
  const srcCounter = readFrameCounter(lastFirstBlock, width);
  assert(srcCounter >= 22 && srcCounter <= 23,
    `第一块尾部输出帧对应源帧22/23（读出 ${srcCounter}），帧率转换可追溯`);
  assert(hasColorBars(frames[10], width), "混合帧率素材保留彩条");
}

// ---------------------------------------------------------------------------
async function testTransitions(mediaSet) {
  console.log("\n[4] 两种明确转场：占用真实相邻内容");
  const p = makeProject("t_tr", { num: 25n, den: 1n });
  addClip(p, mediaSet.m25a, 0, 19); // 20 frames
  addClip(p, mediaSet.m25b, 0, 19); // 20 frames
  addClip(p, mediaSet.m25c, 0, 19); // 20 frames
  p.transitions = [
    { afterClipIndex: 0, type: "dissolve", duration: rat(5n, 25n) },
    { afterClipIndex: 1, type: "wipe", duration: rat(4n, 25n) },
  ];
  validateProject(p);
  const range = transitionAllowedRange(p, 0);
  assertEq(range.maxFrames, 20n, "转场可选范围上限来自两侧真实余量(20帧)");

  const plan = planTimeline(p);
  assertEq(plan.totalFrames, 60n - 5n - 4n, "总帧数扣除两段转场重叠 = 51");
  const { video, manifestDoc } = await render(p, "trans");
  assertEq(await probeFrames(video), 51n, "转场导出实测 51 帧");

  const { frames, width } = await extractRawFrames(video);
  // Dissolve region starts at output frame 20-5=15; a mid-dissolve frame must
  // blend both bands rather than equal either source band exactly.
  const midDissolve = frames[17];
  const bandA = hexToRgb(mediaSet.m25a.bandColor);
  const bandB = hexToRgb(mediaSet.m25b.bandColor);
  assert(!colorClose(readBandColor(midDissolve, width), bandA, 25) &&
         !colorClose(readBandColor(midDissolve, width), bandB, 25),
    "叠化中段帧是两素材混合，不是单侧边缘帧重复");
  // Before and after the dissolve the bands are pure A then B.
  assert(colorClose(readBandColor(frames[14], width), bandA), "叠化前为纯素材A");
  assert(colorClose(readBandColor(frames[20], width), bandB), "叠化后为纯素材B");

  // Wipe: at its midpoint the left half of the frame is one material and the
  // right half the other (wiperight). Locate via manifest offset.
  const wipe = manifestDoc.cutsAndTransitions.find((x) => x.kind === "wipe");
  const wipeMid = Number(wipe.offsetFrame) + 2;
  const wf = frames[wipeMid];
  const leftPx = readBandColorAt(wf, width, 0.25);
  const rightPx = readBandColorAt(wf, width, 0.8);
  const bandC = hexToRgb(mediaSet.m25c.bandColor);
  assert(!colorClose(leftPx, rightPx, 30),
    `划像中段左右分属两素材（左 ${leftPx} / 右 ${rightPx}）`);
  // wiperight reveals the incoming clip (C, blue) on the left while the
  // outgoing clip (B, purple) still covers the right.
  assert(colorClose(leftPx, bandC, 45) && colorClose(rightPx, hexToRgb(mediaSet.m25b.bandColor), 45),
    "划像左侧为进入素材C、右侧为退出素材B，均为真实内容");
  const kinds = manifestDoc.cutsAndTransitions.map((x) => x.kind);
  assert(kinds.includes("dissolve") && kinds.includes("wipe"), "清单同时列出 dissolve 与 wipe");
}

function readBandColorAt(frame, width, fx) {
  const x = Math.floor(width * fx);
  const i = (10 * width + x) * 3;
  return [frame[i], frame[i + 1], frame[i + 2]];
}

// ---------------------------------------------------------------------------
async function testFreeze(mediaSet) {
  console.log("\n[5] 静帧停留：引用真实解码帧并标注源位置");
  const p = makeProject("t_freeze", { num: 25n, den: 1n });
  addClip(p, mediaSet.m25a, 2, 15, { frame: 9n, holdFrames: 6n });
  validateProject(p);
  const plan = planTimeline(p);
  // 14 source frames -> 14 output frames, plus 6 held = 20.
  assertEq(plan.blocks[0].frames, 20n, "静帧片段输出帧数 = 源跨度14 + 停留6");

  const { video, manifestDoc } = await render(p, "freeze");
  assertEq(await probeFrames(video), 20n, "静帧导出实测 20 帧");
  const { frames, width } = await extractRawFrames(video);

  // Source frames 2..15 occupy output frames 0..13; freeze source frame 9 would
  // naturally sit at output index 7, then head continues to frame index 7
  // (source 9), the next six frames (8..13) must all show source frame 9.
  const counterAt = (i) => readFrameCounter(frames[i], width);
  const heldValue = counterAt(7);
  assertEq(heldValue, 9, "静帧起点输出帧计数器 = 源帧9");
  const held = [8, 9, 10, 11, 12, 13].map(counterAt);
  assert(held.every((v) => v === 9), `6 帧停留全部锁定源帧9（读出 ${held.join(",")}）`);
  // After the hold, playback resumes at source frame 10.
  assertEq(counterAt(14), 10, "静帧结束后从源帧10继续，未丢尾帧");
  const m = manifestDoc.clips[0].source;
  assert(m.freeze && m.freeze.sourceFrame === "9" && m.freeze.holdFrames === "6",
    "导出清单标注静帧采用的源位置 (frame 9, hold 6)");
}

// ---------------------------------------------------------------------------
async function testHeadroomRejection(mediaSet) {
  console.log("\n[6] 余量不足：给出可选范围，禁止无说明重复边缘帧");
  const p = makeProject("t_head", { num: 25n, den: 1n });
  addClip(p, mediaSet.m25a, 0, 3); // 4 frames
  addClip(p, mediaSet.m25b, 0, 3); // 4 frames
  p.transitions = [{ afterClipIndex: 0, type: "dissolve", duration: rat(8n, 25n) }];
  validateProject(p);
  const errors = checkTransitions(p);
  assertEq(errors.length, 1, "8 帧转场超出 4 帧余量被拦截");
  assert(errors[0].allowed.maxFrames === 4n, `报错给出可选上限 4 帧（实际 ${errors[0].allowed.maxFrames}）`);
  let threw = false;
  try {
    await render(p, "headroom-bad");
  } catch (e) {
    threw = e.code === "HEADROOM";
  }
  assert(threw, "渲染器拒绝余量不足的转场，不生成重复边缘帧的成品");

  // A transition within range succeeds on the same short clips.
  p.transitions[0].duration = rat(3n, 25n);
  const { video } = await render(p, "headroom-ok");
  assertEq(await probeFrames(video), 4n + 4n - 3n, "短片段 3 帧转场导出 5 帧");
}

// ---------------------------------------------------------------------------
async function testAudioSync(mediaSet) {
  console.log("\n[7] 声画位置：同步短音跟随片段入出点");
  const p = makeProject("t_audio", { num: 25n, den: 1n });
  // Media beeps every 10 frames, each beep 2 frames long. The clip starts at
  // source frame 5, so the first beep inside the clip begins at source frame
  // 10 -> output frame 5 -> 200ms on the exact frame grid.
  addClip(p, mediaSet.m25beep, 5, 24);
  validateProject(p);
  const { video } = await render(p, "audio");
  const levels = await extractAudioLevels(video, 48000, 10);
  const ranges = loudRanges(levels, 3000);
  assert(ranges.length >= 2, `检测到 ${ranges.length} 段同步短音（期望≥2）`);
  const firstStart = ranges[0].startMs;
  assert(firstStart >= 190 && firstStart <= 210,
    `首个短音起始沿位于 200ms 帧网格（实际 ${firstStart}ms），声画对齐`);

  // Freeze region must be silent: held picture, no held/repeated audio.
  const p2 = makeProject("t_audio2", { num: 25n, den: 1n });
  addClip(p2, mediaSet.m25beep, 0, 19, { frame: 10n, holdFrames: 10n });
  const r2 = await render(p2, "audio-freeze");
  const lv2 = await extractAudioLevels(r2.video, 48000, 10);
  // Head spans source frames 0..10 (output 0..10), then 10 held output frames
  // occupy output indices 11..20 -> 440ms..840ms. Assert the middle of the hold
  // is silent, away from any beep edge.
  const holdMiddle = lv2.windows.slice(55, 75);
  const quiet = holdMiddle.every((v) => v < 1500);
  assert(quiet, "静帧停留区间中部音频为静音，画面保持而声音不被重复");
  const audioInfo = await probeAudio(r2.video);
  const expectSamples = Math.round(Number(48000n * 30n / 25n)); // 20 span + 10 hold
  assert(Math.abs(audioInfo.samples - expectSamples) <= 2048,
    `音频样本数匹配输出时长（${audioInfo.samples} ≈ ${expectSamples}）`);
}

// ---------------------------------------------------------------------------
async function testStoreRevisions(tmpRoot, mediaSet) {
  console.log("\n[8] 保存重开 + 修订隔离");
  const store = new ProjectStore(tmpRoot);
  await store.init();
  const p = makeProject("t_store", { num: 25n, den: 1n });
  addClip(p, mediaSet.m25a, 0, 9);
  const r1 = await store.save(p);
  assertEq(r1.revision, 1, "首次保存为修订 1");
  addClip(r1, mediaSet.m25b, 0, 4);
  const r2 = await store.save(r1);
  assertEq(r2.revision, 2, "再次保存产生修订 2");

  const reopened = await store.load("t_store", 1);
  assertEq(reopened.clips.length, 1, "重开修订1 只有 1 个片段（历史修订不可变）");
  const latest = await store.load("t_store");
  assertEq(latest.clips.length, 2, "重开最新修订有 2 个片段");
  const revs = await store.revisions("t_store");
  assert(revs.length === 2 && revs[0] === 1 && revs[1] === 2, "修订历史完整可枚举");

  // JSON round trip preserves BigInt rationals exactly.
  const revived = reviveProject(JSON.parse(JSON.stringify(
    JSON.parse(serializeProject(latest)))));
  assertEq(revived.clips[0].inFrame, 0n, "序列化/反序列化保持整数帧精度");
  assertEq(revived.output.fps.num, 25n, "输出帧率有理字段保真");
}

// ---------------------------------------------------------------------------
async function testCancelAndStale(tmpRoot, mediaSet) {
  console.log("\n[9] 取消任务：临时文件不进入成品列表");
  const p = makeProject("t_cancel", { num: 25n, den: 1n });
  for (let i = 0; i < 6; i++) addClip(p, i % 2 ? mediaSet.m25b : mediaSet.m25a, 0, 19);
  validateProject(p);
  const workDir = path.join(tmpRoot, "cancel_work");
  const finalDir = path.join(tmpRoot, "cancel_final");
  let handle = null;
  const renderPromise = renderProject({
    frozen: p, workDir, finalDir, jobId: "j_cancel",
    emit: () => {},
    shouldCancel: (() => { let n = 0; return () => ++n > 1; })(),
    registerHandle: (h) => { handle = h; },
  });
  let cancelled = false;
  try { await renderPromise; } catch (e) { cancelled = !!e.cancelled; }
  assert(cancelled, "取消信号终止渲染并抛出 cancelled");
  const finals = await fs.readdir(finalDir).catch(() => []);
  assert(finals.length === 0, "成品目录没有登记任何取消任务的文件");
  // The renderer keeps work files for the JobManager to own; emulate the
  // manager's finally-block cleanup and assert nothing staged survives as a
  // deliverable. The staged output must never have been renamed into final.
  const staged = await fs.readdir(workDir).catch(() => []);
  assert(!staged.some((f) => f.endsWith(".mp4") && !f.startsWith("clip")),
    "取消时没有任何成片被提升出工作目录");
  await rmrf(workDir);
  const workGone = await fs.access(workDir).then(() => false).catch(() => true);
  assert(workGone, "任务结束后工作临时目录可被安全清理");
}

// ---------------------------------------------------------------------------
async function main() {
  await rmrf(TMP);
  await fs.mkdir(TMP, { recursive: true });
  const mediaDir = path.join(TMP, "media");
  await fs.mkdir(mediaDir, { recursive: true });

  console.log("生成测试素材（彩条 + 二进制帧序号 + 同步短音）…");
  const opts = (id, fps, frames, beepEvery = 10, index = 0) => ({
    id, index, frames: BigInt(frames), fps, sampleRate: 48000, beepEvery,
  });
  const mediaSet = {};
  mediaSet.m25a = await generateMedia(mediaDir, opts("m25a", { num: 25n, den: 1n }, 40, 10, 0));
  mediaSet.m25b = await generateMedia(mediaDir, opts("m25b", { num: 25n, den: 1n }, 40, 10, 1));
  mediaSet.m25c = await generateMedia(mediaDir, opts("m25c", { num: 25n, den: 1n }, 40, 10, 2));
  mediaSet.m24 = await generateMedia(mediaDir, opts("m24", { num: 24n, den: 1n }, 40, 12, 3));
  mediaSet.m30 = await generateMedia(mediaDir, opts("m30", { num: 30n, den: 1n }, 45, 15, 4));
  mediaSet.m2997 = await generateMedia(mediaDir, opts("m2997", { num: 30000n, den: 1001n }, 32, 10, 5));
  mediaSet.m25beep = await generateMedia(mediaDir, opts("m25beep", { num: 25n, den: 1n }, 40, 10, 0));

  await testRational();
  await testShortClipHardCuts(mediaSet);
  await testMixedFps(mediaSet);
  await testTransitions(mediaSet);
  await testFreeze(mediaSet);
  await testHeadroomRejection(mediaSet);
  await testAudioSync(mediaSet);
  await testStoreRevisions(path.join(TMP, "store"), mediaSet);
  await testCancelAndStale(path.join(TMP, "jobroot"), mediaSet);

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  if (failed) {
    console.error("失败项：\n - " + failures.join("\n - "));
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
