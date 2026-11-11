const $ = (s) => document.querySelector(s);
const api = async (url, opts = {}) => {
  const res = await fetch(url, {
    headers: { "content-type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { data, status: res.status });
  return data;
};

const state = {
  projects: [],
  project: null,
  selectedClip: null,
  pollTimer: null,
  previewTimer: null,
};

// BigInt values travel as strings over JSON; keep them as strings in the editor
// and only parse when building a save body.
const bi = (v) => BigInt(v);

async function loadProjectList() {
  state.projects = await api("/api/projects");
  const sel = $("#projectSelect");
  sel.innerHTML = "";
  if (!state.projects.length) {
    sel.innerHTML = `<option value="">（无工程，点击新建）</option>`;
    return;
  }
  for (const p of state.projects) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = `${p.name} · rev${p.revision} · ${p.clips}片段 · ${p.outputFps}fps`;
    sel.appendChild(o);
  }
}

async function openProject(id) {
  if (!id) { state.project = null; renderAll(); return; }
  state.project = await api(`/api/projects/${id}`);
  state.selectedClip = state.project.clips[0]?.id || null;
  renderAll();
}

async function refreshProject() {
  if (!state.project) return;
  const keepSel = state.selectedClip;
  state.project = await api(`/api/projects/${state.project.id}`);
  if (!state.project.clips.some((c) => c.id === keepSel)) state.selectedClip = null;
  else state.selectedClip = keepSel;
  renderAll();
}

// ---------- media ----------
async function loadMedia() {
  const media = await api("/api/media");
  const tb = $("#mediaTable tbody");
  tb.innerHTML = "";
  for (const m of media) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${m.name}</td>
      <td>${m.fps}</td>
      <td>${m.frames}</td>
      <td>${m.width}×${m.height}</td>
      <td>${m.audioChannels ? m.sampleRate + "Hz" : "无"}</td>
      <td>${m.beepEvery ? "每" + m.beepEvery + "帧" : "—"}</td>
      <td><button data-add="${m.id}">加入工程</button></td>`;
    tb.appendChild(tr);
  }
  tb.querySelectorAll("[data-add]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!state.project) return alert("请先新建或选择工程");
      await api(`/api/projects/${state.project.id}/media`, {
        method: "POST", body: { mediaId: b.dataset.add },
      });
      await refreshProject();
    }));
}

// ---------- timeline ----------
function renderTimeline() {
  const p = state.project;
  const ol = $("#timeline");
  ol.innerHTML = "";
  if (!p) { $("#timelineInfo").textContent = ""; return; }

  p.clips.forEach((clip, i) => {
    const media = p.media.find((m) => m.id === clip.mediaId);
    const block = p.plan?.blocks?.[i];
    const li = document.createElement("li");
    li.className = "clip" + (state.selectedClip === clip.id ? " selected" : "");
    li.innerHTML = `
      <span class="idx">#${i}</span>
      <div>
        <div class="name">${media?.name || clip.mediaId}
          ${clip.freeze && clip.freeze.holdFrames !== "0"
            ? `<span class="freeze-badge">静帧 源帧#${clip.freeze.frame} ×${clip.freeze.holdFrames}</span>` : ""}
        </div>
        <div class="src">源 ${media?.fps}fps · 帧 ${clip.inFrame}..${clip.outFrame}</div>
      </div>
      <div class="range">输出帧数 ${block ? block.frames : "?"}</div>
      <div class="pos">时间线帧 ${block ? block.startFrame + " → " + block.endFrame : "?"}</div>
      <div class="ops">
        <button data-move="-1" ${i === 0 ? "disabled" : ""}>←</button>
        <button data-move="1" ${i === p.clips.length - 1 ? "disabled" : ""}>→</button>
        <button data-del>删除</button>
      </div>`;
    li.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      state.selectedClip = clip.id;
      renderTimeline();
      renderInspector();
    });
    li.querySelector("[data-del]").addEventListener("click", () => deleteClip(i));
    li.querySelectorAll("[data-move]").forEach((b) =>
      b.addEventListener("click", () => moveClip(i, Number(b.dataset.move))));
    ol.appendChild(li);

    // Transition control between clip i and i+1.
    if (i < p.clips.length - 1) {
      const tr = p.transitions.find((t) => t.afterClipIndex === i);
      const row = document.createElement("div");
      row.className = "transition-row";
      const range = allowedRangeFor(i);
      row.innerHTML = `
        <span>边界 ${i}↔${i + 1} 转场：</span>
        <select data-tr-type>
          <option value="none" ${!tr ? "selected" : ""}>无（硬切）</option>
          <option value="dissolve" ${tr?.type === "dissolve" ? "selected" : ""}>叠化 dissolve</option>
          <option value="wipe" ${tr?.type === "wipe" ? "selected" : ""}>划像 wipe</option>
        </select>
        <label>时长(帧) <input type="number" min="1" data-tr-frames value="${tr ? tr.frames : Math.min(5, Number(range.maxFrames) || 1)}"></label>
        <span>可选范围 1..${range.maxFrames} 帧（≤ ${range.maxDuration}）</span>
        <span data-tr-msg></span>`;
      row.querySelector("[data-tr-type]").addEventListener("change", () => applyTransition(i, row));
      row.querySelector("[data-tr-frames]").addEventListener("change", () => applyTransition(i, row));
      ol.appendChild(row);
    }
  });

  const info = $("#timelineInfo");
  if (p.plan) {
    info.textContent = `工程输出 ${p.output.fps}fps · 采样率 ${p.output.sampleRate}Hz · 计划总帧数 ${p.plan.totalFrames}（整数帧网格，无浮点累加）`;
  }
  renderHeadroom();
}

function allowedRangeFor(boundary) {
  const p = state.project;
  const tr = p.transitions.find((t) => t.afterClipIndex === boundary);
  if (tr) return { maxFrames: tr.allowed.maxFrames, maxDuration: tr.allowed.maxDuration };
  // Compute client-side conservatively from clip source spans.
  const outFps = parseFps(p.output.fps);
  let max = 0n;
  const left = p.clips[boundary];
  const right = p.clips[boundary + 1];
  if (left && right) {
    const l = minAvail(left, p.media, outFps);
    const r = minAvail(right, p.media, outFps);
    max = l < r ? l : r;
  }
  const maxDur = max === 0n ? "0s" : `${max * outFps.den}/${outFps.num}s`;
  return { maxFrames: max.toString(), maxDuration: maxDur };
}

function parseFps(s) {
  const [n, d] = s.split("/").map(BigInt);
  return { num: n, den: d || 1n };
}

function minAvail(clip, media, outFps) {
  const m = media.find((x) => x.id === clip.mediaId);
  const span = bi(clip.outFrame) - bi(clip.inFrame) + 1n;
  const exact = span * m.fps.den * outFps.num / (m.fps.num * outFps.den);
  const hold = clip.freeze ? bi(clip.freeze.holdFrames) : 0n;
  return exact + hold;
}

function renderHeadroom() {
  const p = state.project;
  const box = $("#headroomBox");
  const errs = p.headroomErrors || [];
  if (!errs.length) { box.classList.add("hidden"); return; }
  box.classList.remove("hidden");
  box.innerHTML = "<b>转场余量不足（禁止重复边缘帧）：</b><br>" +
    errs.map((e) => `· ${e.message}`).join("<br>");
}

async function applyTransition(boundary, row) {
  const p = state.project;
  const type = row.querySelector("[data-tr-type]").value;
  const frames = BigInt(row.querySelector("[data-tr-frames]").value || 1);
  const outFps = parseFps(p.output.fps);
  let transitions = p.transitions.filter((t) => t.afterClipIndex !== boundary);
  if (type !== "none") {
    transitions.push({
      afterClipIndex: boundary, type,
      durationN: (frames * outFps.den).toString(),
      durationD: outFps.num.toString(),
    });
  }
  transitions.sort((a, b) => a.afterClipIndex - b.afterClipIndex);
  await save({ transitions });
}

async function deleteClip(index) {
  const p = state.project;
  const clips = p.clips.filter((_, i) => i !== index);
  // Drop transitions that referenced removed boundaries and re-index.
  const oldToNew = p.clips.map((c, i) => i).filter((i) => i !== index)
    .reduce((acc, oldIdx, newIdx) => (acc[oldIdx] = newIdx, acc), {});
  const transitions = p.transitions
    .filter((t) => t.afterClipIndex !== index && t.afterClipIndex !== index - 1)
    .map((t) => {
      const shifted = t.afterClipIndex > index ? t.afterClipIndex - 1 : t.afterClipIndex;
      return { ...t, afterClipIndex: shifted };
    });
  await save({ clips, transitions });
}

async function moveClip(index, dir) {
  const p = state.project;
  const clips = p.clips.map((c) => ({ ...c }));
  const j = index + dir;
  [clips[index], clips[j]] = [clips[j], clips[index]];
  // Rebuild transitions conservatively: clear all on the two affected
  // boundaries; the user re-applies them against fresh headroom ranges.
  const transitions = p.transitions
    .filter((t) => ![index - 1, index, j - 1, j].includes(t.afterClipIndex))
    .map((t) => {
      const a = t.afterClipIndex;
      if (a === index || a === j) return t;
      return { ...t, afterClipIndex: a > index ? a - 1 : a < index ? a + 1 : a };
    })
    .filter((t) => t.afterClipIndex >= 0 && t.afterClipIndex < clips.length - 1);
  await save({ clips, transitions });
}

// ---------- inspector ----------
function renderInspector() {
  const p = state.project;
  const box = $("#inspector");
  if (!p || !state.selectedClip) {
    box.className = "inspector empty";
    box.textContent = "选择时间线上的片段进行编辑";
    return;
  }
  box.className = "inspector";
  const idx = p.clips.findIndex((c) => c.id === state.selectedClip);
  const clip = p.clips[idx];
  const media = p.media.find((m) => m.id === clip.mediaId);
  const maxFrame = Number(media.frames) - 1;
  const freeze = clip.freeze || { frame: clip.outFrame, holdFrames: "0" };
  box.innerHTML = `
    <div class="field">
      <h4>入点 inFrame（源整数帧，0..${maxFrame}）</h4>
      <input type="number" min="0" max="${maxFrame}" id="inFrame" value="${clip.inFrame}">
    </div>
    <div class="field">
      <h4>出点 outFrame（含）</h4>
      <input type="number" min="0" max="${maxFrame}" id="outFrame" value="${clip.outFrame}">
    </div>
    <div class="field">
      <h4>静帧源帧 freeze.frame（必须落在入出点内）</h4>
      <input type="number" min="${clip.inFrame}" max="${clip.outFrame}" id="freezeFrame" value="${freeze.frame}">
      <div class="src-note">静帧引用该位置的真实解码帧，预览与导出清单均标注源位置</div>
    </div>
    <div class="field">
      <h4>静帧停留输出帧数 holdFrames（0=关闭）</h4>
      <input type="number" min="0" id="holdFrames" value="${freeze.holdFrames}">
    </div>
    <div class="field">
      <h4>操作</h4>
      <button id="applyInspector" class="primary">应用入出点 / 静帧</button>
    </div>`;
  $("#applyInspector").addEventListener("click", async () => {
    const inFrame = BigInt($("#inFrame").value);
    const outFrame = BigInt($("#outFrame").value);
    const fFrame = BigInt($("#freezeFrame").value);
    const hold = BigInt($("#holdFrames").value);
    if (inFrame < 0n || outFrame > BigInt(maxFrame) || outFrame < inFrame) {
      return alert("入出点超出素材范围或顺序错误");
    }
    if (fFrame < inFrame || fFrame > outFrame) {
      return alert("静帧源帧必须位于入出点之间");
    }
    const clips = p.clips.map((c) => c.id === clip.id ? {
      ...c,
      inFrame: inFrame.toString(),
      outFrame: outFrame.toString(),
      freeze: hold > 0n ? { frame: fFrame.toString(), holdFrames: hold.toString() } : null,
    } : c);
    await save({ clips });
  });
}

// ---------- save / project doc ----------
async function save(patch) {
  const p = state.project;
  const body = {
    name: p.name,
    clips: (patch.clips || p.clips).map((c) => ({
      id: c.id, mediaId: c.mediaId,
      inFrame: c.inFrame.toString(), outFrame: c.outFrame.toString(),
      freeze: c.freeze ? {
        frame: c.freeze.frame.toString(), holdFrames: c.freeze.holdFrames.toString(),
      } : null,
    })),
    transitions: (patch.transitions || p.transitions).map((t) => ({
      afterClipIndex: t.afterClipIndex, type: t.type,
      durationN: t.durationN ?? t.duration.split("/")[0],
      durationD: t.durationD ?? (t.duration.split("/")[1] || "1"),
    })),
  };
  const saved = await api(`/api/projects/${p.id}`, { method: "PUT", body });
  state.project = saved;
  renderAll();
}

// ---------- render / preview / jobs ----------
async function startRender(isPreview) {
  const p = state.project;
  if (!p.clips.length) return alert("时间线为空");
  try {
    if (isPreview) {
      await api(`/api/projects/${p.id}/preview`, { method: "POST" });
      pollPreview();
    } else {
      const job = await api(`/api/projects/${p.id}/render`, { method: "POST" });
      pollJob(job.jobId);
    }
  } catch (e) {
    if (e.status === 409 && e.data?.details) {
      alert("转场余量不足：\n" + e.data.details.map((d) => d.message).join("\n"));
    } else alert(e.message);
  }
}

function pollJob(jobId) {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(async () => {
    const s = await api(`/api/jobs/${jobId}`);
    $("#jobState").textContent =
      `任务 ${s.jobId} · 修订 r${s.revision} · ${s.state} · 阶段 ${s.phase} · ${Math.round((s.progress || 0) * 100)}%`;
    $("#progressBar").style.width = `${(s.progress || 0) * 100}%`;
    if (s.state === "done" || s.state === "failed" || s.state === "cancelled") {
      clearInterval(state.pollTimer);
      if (s.state === "failed" && s.headroom) {
        $("#jobState").textContent += " — " + s.headroom.map((h) => h.message).join("; ");
      }
      await loadProducts();
    }
  }, 700);
}

function pollPreview() {
  clearInterval(state.previewTimer);
  state.previewTimer = setInterval(async () => {
    const s = await api(`/api/projects/${state.project.id}/preview`);
    $("#jobState").textContent =
      `预览 · 修订 r${s.revision} · ${s.state} · ${Math.round((s.progress || 0) * 100)}%`;
    $("#progressBar").style.width = `${(s.progress || 0) * 100}%`;
    if (s.state === "done") {
      clearInterval(state.previewTimer);
      renderPreview(s);
    } else if (s.state === "failed" || s.state === "cancelled") {
      clearInterval(state.previewTimer);
    }
  }, 700);
}

function renderPreview(s) {
  const p = state.project;
  const box = $("#previewBox");
  const url = `/api/preview/video/${p.id}/${s.revision}?t=${Date.now()}`;
  const sources = (s.manifest?.clips || []).map((c) => {
    const fr = c.source.freeze ? `；静帧源帧#${c.source.freeze.sourceFrame} 停留${c.source.freeze.holdFrames}帧` : "";
    return `片段${c.clipIndex}: 源[${c.source.mediaName} ${c.source.sourceFps}fps 帧${c.source.inFrame}..${c.source.outFrame}]${fr}`;
  }).join("<br>");
  box.innerHTML = `
    <video controls src="${url}"></video>
    <div class="srcpos">
      预览对应修订 r${s.revision}，实测总帧数 ${s.manifest?.measuredTotalFrames}<br>${sources}
    </div>`;
}

async function loadProducts() {
  if (!state.project) return;
  const items = await api(`/api/projects/${state.project.id}/products`);
  const tb = $("#productsTable tbody");
  tb.innerHTML = "";
  for (const e of items) {
    const tr = document.createElement("tr");
    const effects = (e.manifest.cutsAndTransitions || []).map((x) =>
      x.kind === "cut" ? `硬切@${x.atOutputFrame}` : `${x.kind}@${x.offsetFrame}(${x.frames}帧)`).join("，");
    tr.innerHTML = `
      <td>${e.jobId}</td>
      <td>r${e.revision}</td>
      <td>${e.manifest.plannedTotalFrames} / ${e.manifest.measuredTotalFrames}</td>
      <td class="effects">${effects || "纯硬切"}</td>
      <td>
        <a class="dl" href="${e.videoUrl}">下载 MP4</a>
        <a class="dl" href="${e.manifestUrl}">导出清单 JSON</a>
      </td>`;
    tb.appendChild(tr);
  }
}

// ---------- wiring ----------
function renderAll() {
  renderTimeline();
  renderInspector();
  loadProducts();
  const p = state.project;
  $("#projectMeta").textContent = p
    ? `${p.name} · rev${p.revision} · 输出 ${p.output.width}×${p.output.height} @ ${p.output.fps}fps`
    : "";
}

$("#newProjectBtn").addEventListener("click", () => $("#newProjectDialog").showModal());
$("#newProjectForm").addEventListener("submit", async (e) => {
  if (e.submitter?.value !== "confirm") return;
  const p = await api("/api/projects", {
    method: "POST",
    body: {
      name: $("#npName").value,
      fpsNum: Number($("#npFpsNum").value),
      fpsDen: Number($("#npFpsDen").value),
      sampleRate: Number($("#npSr").value),
    },
  });
  await loadProjectList();
  $("#projectSelect").value = p.id;
  await openProject(p.id);
});

$("#projectSelect").addEventListener("change", (e) => openProject(e.target.value));
$("#saveBtn").addEventListener("click", async () => {
  // Re-save current doc to force a fresh revision (e.g. after external change).
  await refreshProject();
  await save({});
  await loadProjectList();
});

$("#genMediaBtn").addEventListener("click", async () => {
  await api("/api/media/generate", {
    method: "POST",
    body: {
      fpsNum: Number($("#genFpsNum").value),
      fpsDen: Number($("#genFpsDen").value),
      frames: Number($("#genFrames").value),
      beepEvery: Number($("#genBeep").value),
      sampleRate: Number($("#genSr").value),
    },
  });
  await loadMedia();
});

$("#genMixedBtn").addEventListener("click", async () => {
  const specs = [
    { fpsNum: 24, fpsDen: 1, frames: 36, beepEvery: 12 },
    { fpsNum: 25, fpsDen: 1, frames: 30, beepEvery: 10 },
    { fpsNum: 30, fpsDen: 1, frames: 45, beepEvery: 15 },
    { fpsNum: 30000, fpsDen: 1001, frames: 32, beepEvery: 10 },
  ];
  for (const s of specs) {
    await api("/api/media/generate", { method: "POST", body: s });
  }
  await loadMedia();
});

$("#previewBtn").addEventListener("click", () => startRender(true));
$("#renderBtn").addEventListener("click", () => startRender(false));
$("#cancelBtn").addEventListener("click", async () => {
  const txt = $("#jobState").textContent;
  const m = txt.match(/任务 (\w+)/);
  if (!m) return alert("没有进行中的导出任务");
  await api(`/api/jobs/${m[1]}/cancel`, { method: "POST" });
});

(async function init() {
  await loadProjectList();
  await loadMedia();
  if (state.projects.length) {
    $("#projectSelect").value = state.projects[0].id;
    await openProject(state.projects[0].id);
  }
})();
