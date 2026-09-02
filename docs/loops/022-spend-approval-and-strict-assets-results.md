# Loop 022: Spend Approval And Strict Assets Results

Date: 2026-09-02
Status: active

## Outcome

本轮取消全局和单视频硬费用上限。图片与视频按导演最终选中的逐镜方案报价，只有人工批准不可变报价后才调用付费 Provider；MiniMax TTS 自动执行、不弹报价并继续记账；GLM-5.3-Flash 视觉审片使用 Code Plan，不产生现金报价。

素材执行不再用说明卡掩盖图库为空、下载失败、生成失败或复用失败。只有导演显式选择 `local-editorial-v1 + editorial_card` 才允许说明卡，且成片文案禁止暴露内部工作流术语。`REUSE_ONLY` 直接或间接复用已解析的母片，不新增调用和费用。

## Product Decisions

- 拒绝素材报价只保存结构化反馈，不自动调用导演；用户主动点击“重新规划”后才生成完整新方案和新报价。
- `SpendPlan.maxCostCny` 只表示当前不可变报价的最高授权扣费，不是视频预算。
- 历史 `maxCostCny`、`maxPaidShots` 和模板 `costPolicy` 只保留解析兼容，不能影响新运行。
- TTS 的配置估价是整条旁白的后台核算值；部分场景成功时只记录已物化场景所占份额。
- 本地只做自动化验证；所有功能统一收口后经 GitHub Actions 部署，再做阿里云桌面和移动端点击测试。

## Implemented

- Workflow Core 分离 `billing` 与 `approvalPolicy`，新的 metered Provider 默认人工审批。
- Production Pipeline 实现逐镜图片/视频报价、授权绑定、拒绝反馈历史、手动重规划和旧授权失效。
- Python 与 TypeScript 素材执行器共同拒绝隐式说明卡、失败生成任务、缺失镜头和非法复用图。
- Provider 目录声明 `stock_video`、`generated_video`、`generated_image`、`editorial_card`，节点编辑器不再硬编码模型分支。
- 生产部署 workflow 使用 GitHub commit SHA，避免远端部署漂移到未经验证的代码。
- MiniMax operation ledger 在多场旁白部分成功时按已物化场景份额累计配置成本；生产环境显式暴露 `MINIMAX_TTS_ESTIMATED_CNY_PER_CLIP`。
- 生产 CLI 在 run 失败时同时返回非零结果并设置进程退出码，GitHub Actions 不再把 `status: failed` 当成成功；Linux smoke 通过独立的显式导演路由主动选择本地静态编辑画面，不放宽生产素材门禁。
- 导演提示词与独立审计合同显式声明 `REUSE_ONLY scene N`：只能复用更早且已解析的母片，不重新搜索、生成或计费，也不能声称复用产生了新动作、光线或状态。没有可执行的免费/复用路线时必须保留可执行付费镜头重新报价，不能用 `confidence=0` 或“不得调用”伪装成完成方案。
- 导演 prompt pack、执行回执和 agent checkpoint contract 同步升级至 `director-v10`，避免失败运行继续复用已耗尽的 v9 checkpoint。

## Verification So Far

- `npm test`: core 298 passed、1 个真实 E2E skip；broker 85 passed；Studio Vitest 189 passed；Studio server 287 passed；production build 与 package smoke 3 passed。`director-v10` 修复后于 2026-09-02 重新完整执行并通过。
- `PYTHONPATH=src .local/python/.venv/bin/python -m unittest discover -s tests`: 98 passed。
- 混合报价集成用例验证生成图片 ¥0.25、生成视频 ¥2.40，授权前两个外部 adapter 都是 0 次，授权后各调用 1 次，最终计划引用真实文件而非说明卡。
- 新增 MiniMax 部分成功回归用例先以 `0.50 != 0.25` 失败，再在最小实现后通过；`tests.test_voiceover` 共 15 个测试通过。
- `bash -n`、`docker-compose ... config -q` 与 `git diff --check` 通过；`video-factory:preflight` production image 构建成功。
- Linux container smoke 的 9 个节点全部 `succeeded`，技术审片 `passed`；最终 MP4 经 `ffprobe` 核验为 1080×1920、30fps、20.000 秒、600 帧。

`director-v10` 的本地 TDD 证据：新增断言后 3 个用例分别因 prompt version、`assetReuse` 审计合同和 execution receipt 仍为 v9 而失败；最小实现后相关 73/73、broker 85/85、production-pipeline 238/238（另 1 个真实 E2E skip）以及完整 `npm test` 均通过，`git diff --check` 通过。

## Deployed Baseline And Cloud QA

- 基线发布 SHA `e771e2f1b728d957a5936b69b949cd78bad23514` 已由 GitHub Actions run `33623889159` 构建并部署；Tests、dependency security、Docker build、Linux video smoke 和阿里云部署全部成功。
- 阿里云 release SHA 与该 commit 一致，`video_factory_prod` healthy，`vf-codex-broker` 与 `vf-zai-codex-broker` active，`/api/health` 正常。生产代码未通过 SSH 手工覆盖。
- 云端桌面和 `390x844` 移动端已验证新建制作、Provider/model 选择、底部导航、配置和素材页；`local-editorial-v1` 默认未选，移动端没有整页横向溢出。
- 免费 run `run-9e85a961-dca4-4eea-8a1b-451af5e8dd56` 在图库无合格素材时明确停在 scene 5，消费 ¥0.00，未生成任何说明卡。
- 付费门禁 run `run-85e9d083-d1c9-4dbf-a0bb-04d9901227e4` 首次给出 6 个 MiniMax H3 镜头、每镜 ¥2、合计 ¥12；授权前消费、授权和付费 receipt 均为 0。
- 点击“这份报价不合适”并保存 ¥0 目标与免费/复用反馈后，只把 run 标为 `stale`，没有自动调用导演；人工点击继续生成后仍未产生付费调用或说明卡。
- 该次真实重规划最终被独立审计拒绝：导演把“复用母片”误解为 Hailuo 必须跨任务继承参考帧，并输出 `confidence=0` 的不可调用候选。源码和运行 trace 共同确认，执行器与报价器已经支持 `REUSE_ONLY`，缺口是 v9 真实导演 prompt 和审计合同没有声明该路由；这正是本次 `director-v10` 修复的直接原因。

## Oracle Web Status

此前 loop event #43 的 Oracle 结论无效：旧 session 错误附着到无关 conversation。后续独立 session 分别出现 `promptSubmitted: false` 和 `Thinking time: chip not found (requested Max)`，模型选择未验证。用户明确要求再次尝试后，独立 session `videofacto-urgent-capability-20260902-v2` 回读为 `Thinking time: Pro，第 5 项，共 5 项`，与当时请求不一致，因此在提交前停止。重新完整读取最新 `oracle-web` Skill 后，独立 v4 session 又返回 `selection unverified (requested Ultra)` 并在提交附件前终止。本次再次完整读取同一 Skill 后，v5 session 仍只回读 `Pro，第 5 项，共 5 项`，wrapper 明确报出 `selection unverified (requested Ultra); refusing to submit`。按当前 Skill，这些调用全部没有可用结果，也不得自动重试；event #45、#47、#48 和 #49 记录了纠正与阻塞证据。旧 `oracle` Skill 未使用；本轮没有检查、升级、安装或修改 Oracle 工具。

## Pending Release Evidence

- 提交并通过 GitHub Actions 部署 `director-v10`，确认 ECS release SHA 对齐；禁止 SSH 覆盖生产代码。
- 云端重新运行真实费用反馈：确认导演能产出合法 `REUSE_ONLY`，复用镜头不重复报价，且无免费/复用方案时返回真实付费报价而非不可调用假方案。
- 桌面与 `390x844` 移动端重走报价拒绝、手动重规划和失败停机路径；不批准测试中的任何付费镜头。
- 在最终真实成片存在后再核验 `ffprobe` 帧数/时长、`blackdetect`、逐片段画面、视觉一致性、内部术语和未授权卡片。
- Oracle Web 在网页模型与 thinking selection 可验证后的独立能力评估。
