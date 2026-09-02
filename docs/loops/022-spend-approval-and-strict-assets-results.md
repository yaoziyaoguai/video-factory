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
- 新增同一 run 的审片返修闭环：visual finding 按实际视频时长和当前 render manifest 定位到 scene；人工可选择更早的已物化 scene 作为母片，生成新的 assets human version，并只重跑 render、technical review、visual review 和 final review。
- 场景返修会验证当前 review、render manifest、asset plan 和 media artifacts 的 kind、producer、run 目录边界、SHA-256 与大小；拒绝说明卡母片、重复 scene、缺失引用和复用循环，并同步传播直接或间接复用依赖。
- Studio 使用专用 `POST /api/runs/:runId/scene-revisions`，通用 decisions 继续只处理 approve/reject；审片界面可点击 finding 跳到对应时间点，选择母片并填写返修说明。

## Verification So Far

- `npm test`: core 298 passed、1 个真实 E2E skip；broker 85 passed；Studio Vitest 189 passed；Studio server 287 passed；production build 与 package smoke 3 passed。`director-v10` 修复后于 2026-09-02 重新完整执行并通过。
- `PYTHONPATH=src .local/python/.venv/bin/python -m unittest discover -s tests`: 98 passed。
- 混合报价集成用例验证生成图片 ¥0.25、生成视频 ¥2.40，授权前两个外部 adapter 都是 0 次，授权后各调用 1 次，最终计划引用真实文件而非说明卡。
- 新增 MiniMax 部分成功回归用例先以 `0.50 != 0.25` 失败，再在最小实现后通过；`tests.test_voiceover` 共 15 个测试通过。
- `bash -n`、`docker-compose ... config -q` 与 `git diff --check` 通过；`video-factory:preflight` production image 构建成功。
- Linux container smoke 的 9 个节点全部 `succeeded`，技术审片 `passed`；最终 MP4 经 `ffprobe` 核验为 1080×1920、30fps、20.000 秒、600 帧。

`director-v10` 的本地 TDD 证据：新增断言后 3 个用例分别因 prompt version、`assetReuse` 审计合同和 execution receipt 仍为 v9 而失败；最小实现后相关 73/73、broker 85/85、production-pipeline 238/238（另 1 个真实 E2E skip）以及完整 `npm test` 均通过，`git diff --check` 通过。

审片返修闭环于 2026-09-03 按 RED/GREEN 完成：先分别复现 voice 提前执行、时间轴漂移、复用依赖未传播、旧媒体仍在 effective version、报告/计划/媒体篡改未拒绝、Studio 路由与 UI 不可达，再做最小实现。最终根级 `npm test` exit 0：TypeScript 303 passed（1 个显式真实 E2E skip）、broker 85 passed、Studio Vitest 190 passed、Studio server 289 passed、production build 与 package smoke 3 passed；Python unittest 98 passed。

最终 diff 审查又复现并修复了未来镜头可作为母片、旧目标媒体重新进入发布包、asset plan/media producer 未校验、真实说明卡格式漏检、多级复用未同步 `director_routing`、素材预览编号误导、`expectedVersionId` 可省略，以及核心 revision action 缺少运行时校验和 retained artifact ID 未去重。production-pipeline 完整测试第一次因新发布包严格字段不兼容 4 个旧 fixture 而失败；修正为仅对声明 `currentMediaArtifactIds` 的新 revision 走严格选择路径后，55/55 通过。该次失败不计作通过，根级完整验证仍是发布前门禁。

发布前第一次根级 `npm test` 在 typecheck 阶段 exit 2：缺少 `expectedVersionId` 的负向测试夹具仍直接断言为 `NodeRevisionDraft`，被 TypeScript 判定为不安全转换。改成显式 `unknown` 双重断言后从头重跑；第二次根级命令明确 exit 0，第一次失败没有计作通过。

## Deployed Baseline And Cloud QA

- 基线发布 SHA `e771e2f1b728d957a5936b69b949cd78bad23514` 已由 GitHub Actions run `33623889159` 构建并部署；Tests、dependency security、Docker build、Linux video smoke 和阿里云部署全部成功。
- `director-v10` 发布 SHA `eeef976d1010a28ccf209edfaef375044ad4ed54` 已由 GitHub Actions run `33646672481` 构建并部署；Dependency security、Test and build、Docker build、Linux container smoke 和 Deploy to Alibaba ECS 全部成功。阿里云 release SHA 与该 commit 一致，`video_factory_prod` healthy，`vf-codex-broker` 与 `vf-zai-codex-broker` active，`/api/health` 正常，生产代码未通过 SSH 手工覆盖。
- 云端桌面和 `390x844` 移动端已验证新建制作、Provider/model 选择、底部导航、配置和素材页；`local-editorial-v1` 默认未选，移动端没有整页横向溢出。
- 免费 run `run-9e85a961-dca4-4eea-8a1b-451af5e8dd56` 在图库无合格素材时明确停在 scene 5，消费 ¥0.00，未生成任何说明卡。
- 付费门禁 run `run-85e9d083-d1c9-4dbf-a0bb-04d9901227e4` 首次给出 6 个 MiniMax H3 镜头、每镜 ¥2、合计 ¥12；授权前消费、授权和付费 receipt 均为 0。
- 点击“这份报价不合适”并保存 ¥0 目标与免费/复用反馈后，只把 run 标为 `stale`，没有自动调用导演；人工点击继续生成后仍未产生付费调用或说明卡。
- 该次真实重规划最终被独立审计拒绝：导演把“复用母片”误解为 Hailuo 必须跨任务继承参考帧，并输出 `confidence=0` 的不可调用候选。源码和运行 trace 共同确认，执行器与报价器已经支持 `REUSE_ONLY`，缺口是 v9 真实导演 prompt 和审计合同没有声明该路由；这正是本次 `director-v10` 修复的直接原因。
- 部署 v10 后重新运行旧费用反馈 run `run-85e9d083-d1c9-4dbf-a0bb-04d9901227e4`：系统绕开已耗尽的 v9 checkpoint，导演第 2/3 轮以 94 分通过独立审计，并诚实返回 6 个 H3 镜头、每镜 ¥2、总计 ¥12。该脚本要求六种不同动作，不适合原样复用；未批准报价，实际消费和授权均为 ¥0.00。
- 定向合法复用 run `run-ab5fadf1-9111-4223-835b-7bbcc5634545`：导演 v10 第 1/3 轮以 92 分通过独立审计。真实 artifact 中 Scene 4、7 均为 `REUSE_ONLY scene 2`，只引用 Scene 2 的 CUP_A 母片，并明确禁止新增动作、光线、裁切、滤镜或画面状态。
- 同一 run 的不可变报价只包含 Scene 1、3、5、8、9、10、11 七张 Seedream 图片，每张 ¥0.25，总计和最高授权均为 ¥1.75；免费的 Scene 2、6 以及复用的 Scene 4、7 均未计费。页面保持“待确认费用”，未点击“检查并确认”，实际消费、授权、待核对记录和按量调用失败均为 0。
- 桌面端已展开逐镜报价并打开费用反馈弹窗，原因、目标费用和调整意见均可编辑；点击“返回检查”不会保存或触发导演。`390x844` 移动端中页面 `scrollWidth = clientWidth = 390`，弹窗宽 362px，两个决策按钮均完整位于视口内；浏览器控制台 0 error / 0 warning。本轮截图命令受 Playwright CLI 固定 5 秒字体等待超时影响，但 DOM、布局测量和点击操作均正常。

## Oracle Web Status

旧的 `vf-next-capability-20260903`、`v2`、`v3` session 已明确放弃，没有恢复或人工点击发送。重新完整读取五档版 `oracle-web` Skill 后，使用 `/opt/homebrew/bin/oracle-web` 创建独立 session `vf-capability-feedback-loop-20260903`；页面实际进入新的 `/c/6a985627-7e24-83ed-a4f5-5b2017b59791` 对话并返回完整结果，强度回读为 `Pro，第 5 项，共 5 项`。wrapper 记录的 requested model 不能证明网页实际模型，因此网页模型保持未验证。Oracle 建议优先补“审片发现 → 精确 scene → 局部素材修订 → 完整重渲染 → 技术/视觉复验 → 同一 run 人工终审”闭环，而不是增加 Agent 编排；当前主 Codex 已综合并实现该建议。

## Pending Release Evidence

- 本轮 scene revision 变更尚未部署；必须先完成最终 diff 审查，再提交并通过 GitHub Actions 部署阿里云，随后执行云端桌面与 `390x844` 移动端点击验收。禁止 SSH 覆盖生产代码。
- 在最终真实成片存在后再核验 `ffprobe` 帧数/时长、`blackdetect`、逐片段画面、视觉一致性、内部术语和未授权卡片。
- Oracle Web 能力评估开始前必须重新完整读取磁盘上的当前 `oracle-web/SKILL.md`，只按五档规则执行，不使用此前缓存的六档规则；Oracle 仅提供建议，由当前主 Codex 综合并实现。
