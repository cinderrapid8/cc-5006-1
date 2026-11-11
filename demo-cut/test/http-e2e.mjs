const base = "http://localhost:3000";
const call = async (p, opts = {}) => {
  const res = await fetch(base + p, {
    headers: { "content-type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`${p}: ${data.error}`), { data, status: res.status });
  return data;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, cond, extra = "") => {
  results.push({ name, ok: !!cond, extra });
  console.log(`${cond ? "✓" : "✗"} ${name} ${extra}`);
};

// 1. mixed-fps media
const specs = [
  { fpsNum: 24, fpsDen: 1, frames: 36, beepEvery: 12 },
  { fpsNum: 25, fpsDen: 1, frames: 40, beepEvery: 10 },
  { fpsNum: 30, fpsDen: 1, frames: 45, beepEvery: 15 },
];
const media = [];
for (const s of specs) media.push(await call("/api/media/generate", { method: "POST", body: s }));
check("生成 3 种帧率素材", media.length === 3, media.map((m) => m.fps).join(","));

// 2. project + attach media
const proj = await call("/api/projects", { method: "POST", body: { name: "工作流", fpsNum: 25, fpsDen: 1 } });
for (const m of media) {
  await call(`/api/projects/${proj.id}/media`, { method: "POST", body: { mediaId: m.id } });
}
const p1 = await call(`/api/projects/${proj.id}`);
check("素材挂入工程", p1.media.length === 3);

// 3. build timeline: three clips, a dissolve and a wipe, plus a freeze
const doc = {
  clips: [
    { id: "c1", mediaId: media[0].id, inFrame: "0", outFrame: "19", freeze: null },
    { id: "c2", mediaId: media[1].id, inFrame: "2", outFrame: "21",
      freeze: { frame: "10", holdFrames: "5" } },
    { id: "c3", mediaId: media[2].id, inFrame: "0", outFrame: "24", freeze: null },
  ],
  transitions: [
    { afterClipIndex: 0, type: "dissolve", durationN: "5", durationD: "25" },
    { afterClipIndex: 1, type: "wipe", durationN: "4", durationD: "25" },
  ],
};
const saved = await call(`/api/projects/${proj.id}`, { method: "PUT", body: doc });
check("保存带转场/静帧的时间线", saved.headroomErrors.length === 0,
  `总帧 ${saved.plan.totalFrames}`);
check("转场写入计划", saved.plan.transitions.length === 2,
  saved.plan.transitions.map((t) => `${t.type}:${t.frames}`).join(","));

// 4. headroom rejection over API: keep valid media but request a transition far
// longer than either clip, which the render endpoint must refuse with a 409 and
// an explicit allowed range (no silent edge-frame repetition).
const badDoc = {
  clips: [
    { id: "c1", mediaId: media[0].id, inFrame: "0", outFrame: "19", freeze: null },
    { id: "c2", mediaId: media[1].id, inFrame: "2", outFrame: "21", freeze: null },
  ],
  transitions: [
    { afterClipIndex: 0, type: "dissolve", durationN: "99", durationD: "25" },
  ],
};
await call(`/api/projects/${proj.id}`, { method: "PUT", body: badDoc });
const badRender = await call(`/api/projects/${proj.id}/render`, { method: "POST" })
  .then(() => null).catch((e) => e);
check("超余量转场被渲染 API 拒绝(409)并给出可选范围",
  badRender?.status === 409 && badRender.data.details[0].allowed.maxFrames,
  badRender?.data?.details[0] ? `上限 ${badRender.data.details[0].allowed.maxFrames} 帧` : "");
// restore good doc only after the refusal has been observed
await call(`/api/projects/${proj.id}`, { method: "PUT", body: doc });

// 5. preview (small size), poll until done, verify revision guard
await call(`/api/projects/${proj.id}/preview`, { method: "POST" });
let preview;
for (let i = 0; i < 60; i++) {
  preview = await call(`/api/projects/${proj.id}/preview`);
  if (preview.state === "done" || preview.state === "failed") break;
  await sleep(500);
}
check("预览渲染完成", preview.state === "done", `rev ${preview.revision}`);
const pv = await fetch(`${base}/api/preview/video/${proj.id}/${preview.revision}`);
check("预览视频可下载", pv.status === 200, pv.headers.get("content-type"));
const manifest = await (await fetch(`${base}/api/preview/manifest/${proj.id}/${preview.revision}`)).json();
check("预览清单标注静帧源位置",
  manifest.clips[1].source.freeze.sourceFrame === "10" &&
  manifest.clips[1].source.freeze.holdFrames === "5");

// 6. full export, poll, then check products + download
const job = await call(`/api/projects/${proj.id}/render`, { method: "POST" });
let st;
for (let i = 0; i < 80; i++) {
  st = await call(`/api/jobs/${job.jobId}`);
  if (["done", "failed", "cancelled"].includes(st.state)) break;
  await sleep(500);
}
check("导出任务成功", st.state === "done", st.state);
const products = await call(`/api/projects/${proj.id}/products`);
check("成品登记 1 个且带下载入口", products.length === 1 &&
  products[0].videoUrl.endsWith(".mp4") && products[0].manifestUrl.includes("manifest"));
const dl = await fetch(base + products[0].videoUrl);
check("MP4 下载入口可用", dl.status === 200 && dl.headers.get("content-type") === "video/mp4");
check("成品实测帧数=计划帧数",
  products[0].manifest.plannedTotalFrames === products[0].manifest.measuredTotalFrames,
  products[0].manifest.measuredTotalFrames);

// 7. save/reopen: new revision while no job runs; products of old rev remain
const reopened = await call(`/api/projects/${proj.id}`);
check("重开工程数据一致", reopened.clips.length === 3 && reopened.revision >= 2);
const projList = await call("/api/projects");
check("工程列表可枚举", projList.some((x) => x.id === proj.id));

// 7b. preview revision isolation: kick a preview, immediately create a newer
// revision and preview that; the stale first preview must never register.
const guard = await call("/api/projects", { method: "POST", body: { name: "预览隔离", fpsNum: 25 } });
await call(`/api/projects/${guard.id}/media`, { method: "POST", body: { mediaId: media[1].id } });
const firstSaved = await call(`/api/projects/${guard.id}`, {
  method: "PUT",
  body: { clips: [{ id: "g1", mediaId: media[1].id, inFrame: "0", outFrame: "9", freeze: null }], transitions: [] },
});
const guardFirstRev = firstSaved.revision;
await call(`/api/projects/${guard.id}/preview`, { method: "POST" }); // older revision preview
const secondSaved = await call(`/api/projects/${guard.id}`, {
  method: "PUT",
  body: { clips: [{ id: "g1", mediaId: media[1].id, inFrame: "0", outFrame: "14", freeze: null }], transitions: [] },
});
const guardLatestRev = secondSaved.revision;
await call(`/api/projects/${guard.id}/preview`, { method: "POST" }); // newer revision supersedes
let guardState;
for (let i = 0; i < 60; i++) {
  guardState = await call(`/api/projects/${guard.id}/preview`);
  if (guardState.state === "done" || guardState.state === "failed") break;
  await sleep(500);
}
check("预览登记的是最新修订而非旧任务",
  guardState.state === "done" && guardState.revision === guardLatestRev,
  `rev ${guardState.revision}`);
const oldRev = await fetch(`${base}/api/preview/video/${guard.id}/${guardFirstRev}`);
check("旧修订预览不提供下载（未被旧任务覆盖）", oldRev.status === 404);
const newRev = await fetch(`${base}/api/preview/video/${guard.id}/${guardLatestRev}`);
check("当前修订预览可播放", newRev.status === 200);

// 8. cancellation: create a long project, render, cancel, confirm no product
const big = await call("/api/projects", { method: "POST", body: { name: "取消测试", fpsNum: 25 } });
await call(`/api/projects/${big.id}/media`, { method: "POST", body: { mediaId: media[2].id } });
const manyClips = Array.from({ length: 12 }, (_, i) => ({
  id: `x${i}`, mediaId: media[2].id, inFrame: "0", outFrame: "44", freeze: null,
}));
await call(`/api/projects/${big.id}`, { method: "PUT", body: { clips: manyClips, transitions: [] } });
const cj = await call(`/api/projects/${big.id}/render`, { method: "POST" });
await call(`/api/jobs/${cj.jobId}/cancel`, { method: "POST" });
let cst;
for (let i = 0; i < 40; i++) {
  cst = await call(`/api/jobs/${cj.jobId}`);
  if (["cancelled", "done", "failed"].includes(cst.state)) break;
  await sleep(300);
}
check("任务可取消", cst.state === "cancelled", cst.state);
const cprods = await call(`/api/projects/${big.id}/products`);
check("取消任务不产生成品", cprods.length === 0);

const failed = results.filter((r) => !r.ok);
console.log(`\nHTTP 工作流：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exit(1);
