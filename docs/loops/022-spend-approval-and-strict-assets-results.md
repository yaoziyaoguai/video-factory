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

## Verification So Far

- `npm test`: core 298 passed、1 个真实 E2E skip；broker 85 passed；Studio Vitest 189 passed；Studio server 287 passed；production build 与 package smoke 3 passed。
- `PYTHONPATH=src .local/python/.venv/bin/python -m unittest discover -s tests`: 98 passed。
- 混合报价集成用例验证生成图片 ¥0.25、生成视频 ¥2.40，授权前两个外部 adapter 都是 0 次，授权后各调用 1 次，最终计划引用真实文件而非说明卡。
- 新增 MiniMax 部分成功回归用例先以 `0.50 != 0.25` 失败，再在最小实现后通过；`tests.test_voiceover` 共 15 个测试通过。
- `bash -n`、`docker-compose ... config -q` 与 `git diff --check` 通过；`video-factory:preflight` production image 构建成功。
- Linux container smoke 的 9 个节点全部 `succeeded`，技术审片 `passed`；最终 MP4 经 `ffprobe` 核验为 1080×1920、30fps、20.000 秒、600 帧。

这些仍是工作树阶段证据。GitHub Actions、阿里云部署、云端点击和真实制作成片核验尚未完成，当前不能据此宣称发布完成。

## Oracle Web Status

此前 loop event #43 的 Oracle 结论无效：旧 session 错误附着到无关 conversation。后续独立 session 分别出现 `promptSubmitted: false` 和 `Thinking time: chip not found (requested Max)`，模型选择未验证。用户明确要求再次尝试后，独立 session `videofacto-urgent-capability-20260902-v2` 回读为 `Thinking time: Pro，第 5 项，共 5 项`，与当时请求不一致，因此在提交前停止。重新完整读取最新 `oracle-web` Skill 后，独立 v4 session 又返回 `selection unverified (requested Ultra)` 并在提交附件前终止。本次再次完整读取同一 Skill 后，v5 session 仍只回读 `Pro，第 5 项，共 5 项`，wrapper 明确报出 `selection unverified (requested Ultra); refusing to submit`。按当前 Skill，这些调用全部没有可用结果，也不得自动重试；event #45、#47、#48 和 #49 记录了纠正与阻塞证据。旧 `oracle` Skill 未使用；本轮没有检查、升级、安装或修改 Oracle 工具。

## Pending Release Evidence

- commit、push、GitHub Actions verify/security/deploy 全绿和 ECS release SHA 对齐。
- SSH loopback 隧道下的云端桌面广覆盖点击测试。
- `390x844` 移动端关键路径、最终视频 `ffprobe` 帧数/时长和逐片段画面检查。
- Oracle Web 在网页模型与 thinking selection 可验证后的独立能力评估。
