# 拆解示例资产包（breakdown-demo）

可再分发的产品拆解短演示工程。素材全部由程序生成，每帧带机器可读的
10 位源帧计数器、部件编号与滑动部件动画；音频含 1 kHz 同步短音与
1.4 kHz 单帧声音标记。所有预期值均由 `scripts/lib/recipe.js` 推导，
核验不接受任何默认值伪装。

## 目录

- `pack/` —— 随仓库分发的成品资产包，可直接加载
  - `media/`、`subtitles/`：4 个 60 帧源素材与 ASS 编号字幕（相对路径，可整体搬迁）
  - `project.json`：剪辑工程（片段/转场/来源 provenance）
  - `sources.json`：每个素材的生成参数、标记帧与时间线计划
  - `deliverables/`：约定成片（168 帧）与渲染清单
  - `pack-manifest.json`：全部文件的 SHA-256 与字节数
- `scripts/` —— 制作、重建、续编脚本（步骤即代码）
- `test/e2e-kit.mjs` —— 含负向用例的端到端测试（篡改、缺件、超余量必须显式失败）

## 命令（在 demo-cut 目录执行）

```bash
npm run kit:build   # 从零程序化生成素材并构建资产包（默认输出 kit/pack）
npm run kit:verify  # 干净目录重建，92 项机器测量核验
npm run kit:edit    # 第二位编辑加载资产包续编（修订 2，160 帧）
npm run kit:e2e     # 全链路端到端测试（含负向用例）
```

脚本均支持自定义目录：`node kit/scripts/verify-rebuild.js <packDir> <outDir>`。

## 约定成果与证据

- 成片 168 帧 = 片段总长 184 帧 − 6 帧叠化 − 10 帧划像；边界 2 为硬切
- 转场余量刻意不同：叠化两侧余量充足；10 帧划像顶到 50 帧片段的
  真实余量上限，引擎拒绝任何超余量转场（不重复边缘帧）
- 6 个存活声音标记的成片帧号、源帧追溯、转场混合/划像边缘、硬切瞬间
  全部写入 `kit/rebuild-output/evidence/verify-report.json`，并附
  首帧、末帧、叠化中间帧三张 PNG 证据
- 续编示例收紧 part03 出点（59→47）并把划像改为 6 帧，输出帧数由工程
  自身推导（160），src44 标记仍精确落在成片第 120 帧
