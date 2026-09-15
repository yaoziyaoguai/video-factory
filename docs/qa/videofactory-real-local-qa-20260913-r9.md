# VideoFactory Revision 9 真实本地 QA 报告

- 状态：PAUSED_BY_USER（停止修复与真实重试，仅完成问题记录）
- 日期：2026-09-13（Asia/Shanghai）
- 目标：`http://127.0.0.1:4317`
- 模式：真实 production build，QA-only；不接 fake Broker，不手改状态，不边测边改
- 费用止损：新增媒体已确认 `¥8.75 / ¥50.00`，TTS 尚未执行；无在途/待确认费用

## 1. 最终构建环境基线

- Git：`codex/final-dual-review-cloud-acceptance`，HEAD `b36ebac3189cf574b8e437cbe16eb9d0b228a177`；revision 9 产品修改仍未提交，历史未跟踪证据保留。
- Studio：`http://127.0.0.1:4317`，`/api/health` 为 `ok`，Python、FFmpeg、ffprobe、say 均可用。
- OpenAI Broker：`gpt-5.6-sol / xhigh`，10 kinds / 10 contracts，开始计数 `active=0, queued=0, completed=0, failed=0`。
- ZAI Broker：文本 `glm-5.3 / max`、视觉 `glm-5.3-flash`，10 kinds / 10 contracts，开始计数 `active=0, queued=0, completed=0, failed=0`。
- creative-treatment digest：`3a3ed3bdc94960b7322fbec6c89271c37926e25c967b1f5207b9c33b4ebb473b`；role-audit digest：`67b0c260824d3a2db548255a00ad12be586da2a43abf19f9ad0976a5123f93fc`。
- 最终构建重新登录后的首页截图：`videofactory-real-local-qa-20260913-r9-assets/15-final-build-login.png`、`16-final-build-home.png`。

## 2. 调用前锁定的有限样本与预期

以下输入和预期在最终构建首次模型调用前写定，不根据模型结果回改。每条同路径同根因只允许条件或证据改变后的一次受控恢复。

| 样本 | 入口 / 模型 / 路线 | 锁定输入摘要 | 预期 |
| --- | --- | --- | --- |
| 正例 A | 自有想法 / GLM / 支持的生成与示意 | 原计划 15 秒；新建页在调用前明确显示最短 20 秒，因此锁定为 20 秒竖屏情绪短片：“焦虑像不停弹出的浏览器标签”；抽象桌面标签增殖后归于安静。全部画面可由 AI 生成，只表达主观感受和构图隐喻，不声称心理学结论、真实实验或普遍规律。 | 首次 treatment 真正走 ZAI；空来源不能误拦，知识解释模板默认 42 秒和四职责可在明确 20 秒边界内适配；进入真实报价。若选为主片，继续唯一后半程。 |
| 正例 B | 自有想法 / OpenAI / 图库 | 15 秒竖屏情绪短片：“雨后城市的一分钟呼吸”；使用可取得的通用城市雨后街景图库，只表达由忙到静的情绪变化，不声称同地点连续实拍、统计或实验。 | 通用图库可规划并进入报价；no-match 时诚实报候选不足，不伪造卡片、不把通用情绪表达改成专属实证。 |
| 负例 O | 自有想法 / OpenAI | 要求用“我的同一只未公开保温杯、同一支温度计、两轮连续 30 分钟的真实视频与逐分钟读数”证明保温差异；明确目前没有视频、照片、读数或采集能力，不允许改成教程、图库或 AIGC。 | 首次有效 treatment producer + 独立 audit 后 `needs_source/needs_user`；不得进入编剧，媒体/TTS 增量 0；原因与需要补的专属材料具体可见。 |
| 负例 G | 自有想法 / GLM | 与负例 O 同结构，改为“我的同一部未公开手机、同一网络环境、两轮连续 15 分钟真实录屏、温度和耗电记录”；明确当前完全缺材料且不允许改承诺或伪造。 | 首次有效 treatment producer + 独立 audit 后 `needs_source/needs_user`；不得进入编剧，媒体/TTS 增量 0；模型身份为 ZAI 路由。 |

入口分配补充：热点入口先核对当前来源，不降低双来源门槛；系列入口核对 canon 与下一集可开工条件。若两者没有合格来源/可开工单集，按真实 BLOCKED 记录，不伪造历史状态。报价三动作、暂停/继续、查询、刷新、重启、桌面/手机布局在上述有限 run 中复用覆盖。

## 3. 执行记录

### 3.1 正例 A：GLM 首次路由与运行中查询

- run：`run-e72cd051-e83c-4a9f-8cc8-5a4d2ae70b6f`。
- 创建页选择 `AI 编剧 = GLM-5.3`、`导演 = GLM-5.3`、生成路线、20 秒固定边界和知识解释模板；截图 `17-final-positive-a-input.png`。
- 首个 creative-treatment 请求后，OpenAI 仍 `completed=0,failed=0,active=0`，ZAI 立即 `active=1`，证明新建页选择从首次 treatment 起真实生效，而不是只改页面标签。
- 运行中页面显示原任务结果暂未知；点击一次“查询原任务”后 ZAI 计数仍不变，页面没有新建 request，也没有解暂停或推进付费步骤。
- treatment producer 与 audit 完成后进入编剧，说明普通主观隐喻没有因空 source 被前提检查误拦。后续结果待记录。

### 3.2 负例 O：OpenAI Provider 预语义失败

- run：`run-28eca6a0-e69d-4cd4-9d26-b0c865c3b469`；输入截图 `18-final-openai-negative-input.png`。
- 首次 creative-treatment 在语义输出前终态失败：Broker `reasonCode=process_exit`、`providerWaitMs=212`、`queueWaitMs=0`，OpenAI 从 `completed=0,failed=0` 变为 `completed=0,failed=1`；不是审计得出的 `needs_source`。
- Studio 约 1.2 秒内显示稳定 failed，保留 1 个已完成的前序步骤，创作规划为 `0/3` 轮、已证实模型执行 1 次、结构修复 0、恢复重试 0，并提供“重试失败步骤/调整方案后重新制作”。Broker 已 `active=0`，页面没有继续显示 running；console error=0。
- 证据：`19-final-openai-negative-provider-failure.png`、OpenAI durable outcome。它证明本次终态失败被消费，但不证明 OpenAI 负例语义早停。当前条件未改变，不立即重试；若独立 OpenAI 正例随后真实成功，再允许一次受控恢复。

### 3.3 正例 B：OpenAI 图库路线受控复验后停止

- run：`run-f8aa1d65-48a5-4a5c-b40d-fa233e91389c`；输入截图 `20-final-openai-stock-positive-input.png`。
- 首次 creative-treatment 在约 92ms 后以 `process_exit` 终态失败。确认两个 Broker idle 并用最终构建安全重启后，仅通过页面“重试失败步骤”做了一次条件改变后的受控复验，仍立即 `process_exit`。
- 同路径同根因已再次失败，该链按止损规则停止。没有换题、换 requestId 或降低模型/思考强度；没有进入语义判断、报价、媒体或 TTS。

### 3.4 正例 A：GLM 规划通过后在候选排序失败

- treatment、script、director 均由 ZAI 完成 producer + audit，共 6 次成功；普通抽象示意没有被空来源误拦。
- 随后的 `asset-rank` 被固定路由到 OpenAI，约 67ms 后 `process_exit`，整条 planning 失败。截图 `21-final-glm-positive-asset-rank-failure.png`。
- 页面累计约 10 分钟、7 次真实执行，但顶部仍显示创作规划 `0/3`，调用解释与已发生工作不一致。
- 在失败页把下次 planning 首选从 GLM 保存为 OpenAI，PUT 200 后 run 变为 `stale`。刷新并经过 Studio 重启后仍显示“待重新生成”和“按人工版本继续生成”，且“本次制作选择”与下次构思模型均为 `gpt-5.6-sol`，证明保存与失效状态持久化；截图 `31-glm-positive-stale-after-restart.png`。由于继续会进入已确认故障的 OpenAI 路径，没有点击恢复。

### 3.5 负例 G：GLM 语义早停通过

- run：`run-ddf76683-4113-4140-a56f-be3383bfa9bb`；输入截图 `22-final-glm-negative-input.png`。
- ZAI 仅执行 creative-treatment producer 1 次 + audit 1 次，首次审计后进入 `needs_source`；没有进入编剧，媒体/TTS 增量均为 0。
- 页面明确写出“真实素材目前不可得”，并给出上传真实材料、改成非实验表达、停止制作三个方向。刷新和 Studio 重启后原始原因、1/10 已完成步骤、GLM 模型身份及两项调用仍保留；截图 `23-final-glm-negative-needs-source.png`、`24-glm-negative-refreshed.png`。

### 3.6 OpenAI Broker 故障边界

- 同一次最终部署中，三个不同正式任务均在语义输出前快速 `process_exit`：负例 creative-treatment 212ms、图库正例 creative-treatment 92ms、GLM 正例派生 asset-rank 67ms。安全重启后图库正例的唯一受控复验仍立即同因失败。
- 同一机器、同一 `gpt-5.6-sol/xhigh` 使用 `codex exec -s read-only` 的只读诊断约 19.5 秒成功返回 `VIDEOFACTORY_PROVIDER_OK`；账户用量约 40%。因此已排除账户额度耗尽和模型整体不可用，故障边界收窄到正式 OpenAI Broker 启动 `codex exec` 的调用链；此阶段尚未归因到具体字段或进程环境。
- 最终现场：OpenAI `active=0,queued=0,completed=0,failed=1`；ZAI `active=0,queued=0,completed=2,failed=0`。服务日志为 `.local/runtime/service-logs/openai-r9-final.log`、`zai-r9-final.log`、`studio-r9-final.log`。

## 4. 独立入口、恢复与布局检查

- 热点：真实页为 0 条可采用、3 条历史候选待补来源；三条均明确“当前不可开工”，新建制作禁用并提供“补充原始来源”。没有刷新热点或降低双来源门槛。证据 `26-hot-topic-state.png`。
- 系列：真实页加载 6 条候选、1 条制作机会。当前 E01 的 canonFacts 为 0 条，页面声明可开工，但内容要求同一手机、相同起始电量/充电器的两轮 15 分钟真实对照；新建制作弹窗会完整预填系列承诺、模板、24 秒建议与 20–34 秒边界。这里只检查入口和输入合同，没有启动第二条重复负例。证据 `27-series-state.png`（加载态）、`28-series-loaded.png`、`29-series-new-run-dialog.png`。
- 移动布局：GLM 负例与系列新建弹窗在 390px 下均有 `clientWidth=scrollWidth=390`，无横向溢出；弹窗可用 Escape 关闭，焦点回到“新建制作”，console 0 error。证据 `25-glm-negative-mobile.png`、`30-series-dialog-mobile.png`。
- 桌面：上述页在 1440px 正常显示；GLM 负例刷新后 console 0 error。暂停/继续没有可安全使用的新运行中节点；报价三动作也未到达，均不记 PASS。

## 5. 费用、耗时与当前验收边界

- 新增媒体/TTS：`¥0.00 / ¥50.00`；没有媒体报价、授权、Provider media taskId、TTS、渲染或 unknown 付费任务。
- 文本调用：ZAI 正例 6 次成功 + 1 次 OpenAI asset-rank 失败；ZAI 负例 2 次成功；OpenAI 负例 1 次失败；OpenAI 图库正例首次及唯一受控复验均失败。文本模型走已有订阅，不计现金止损。
- 长耗时原因：GLM 正例约 10 分钟来自 treatment/script/director 的 6 次串行真实调用，不是排队或媒体候选不足；Broker `queueWaitMs=0`。页面把创作规划显示为 `0/3`，没有解释前序 6 次工作，记录为用户可见问题。
- 已通过：GLM 正例语义可继续、GLM 缺专属材料负例及时停止、模型首次路由生效、失败终态及时消费、失败原因刷新/重启保留、热点正确阻断、桌面/移动布局与弹窗键盘关闭。
- BLOCKED / NOT_VERIFIED：OpenAI 正负语义；正例报价与三动作；媒体、TTS、渲染、新成片；同 evidence SHA 的双真实模型审片；审片建议驱动的局部返工；新片实际画面、音频与同步；运行中暂停后显式继续。
- 当时阶段状态为 `IN_PROGRESS`：QA 一轮已完成可测范围，计划集中调查 OpenAI Broker `process_exit` 与 asset-rank 路由；该部署根因随后在 6.1 查明，报告最终状态以第 7 节的 `PAUSED_BY_USER` 为准。

## 6. 纠正部署条件后的受控复验与首个真实报价

### 6.1 OpenAI `process_exit` 根因与纠正

- 已撤回“源码向 Codex CLI 重复传 `--json`”的早期误判；带行号核对后正式 executor 只有一个该参数，没有据此修改产品代码。
- 本轮手工 QA 部署曾把 `VIDEO_FACTORY_CODEX_WORKSPACE_ROOT` 设为相对路径 `.local/runtime/codex/tasks`。executor 已先把 child cwd 切到任务 workspace，再把该值传给 `codex --cd`，CLI 因二次相对解析到不存在的嵌套目录而立即报 `No such file or directory`。相同模型、HTTPS provider、schema、stdin 在绝对 `--cd` 下两次真实只读诊断成功；相对路径无业务探针稳定 exit 1。
- 按正式启动脚本语义改用绝对 workspace 后启动 OpenAI Broker：`gpt-5.6-sol / xhigh`、10 kinds / 10 contracts。随后正式 OpenAI 任务不再快速 `process_exit`。这是 QA 部署偏差，不归类为产品修复。

### 6.2 图库正例 B：OpenAI 能运行，但候选处置错误

- 在部署条件改变后，只对 `run-f8aa1d65-48a5-4a5c-b40d-fa233e91389c` 执行一次页面“重试失败步骤”。OpenAI Broker 从 `completed=0/failed=0` 连续增长到 `completed=12/failed=0`，所有调用 `queue=0`；首次构思、脚本、导演、候选排序及因 no-match 触发的一轮导演/排序修订均真实执行，不再有 `process_exit`。
- 约 14 分钟后有界停止，没有无限重试；但输入已明确“只表达主观情绪、不声称连续实拍、统计或实验”，最终仍提示“上传或实拍可追溯的真实素材/改为不主张实验事实”，把普通图库 no-match 错写成实证缺料。页面只显示旧的 2 次失败执行，没有解释本次 12 次成功调用。截图：`32-openai-stock-controlled-recovery-progress.png`、`33-openai-stock-controlled-recovery-needs-source.png`。
- 运行中请求过“当前步骤完成后暂停”；该暂停边界是整个 creative-planning，节点最终 failed，未形成可显式继续的 paused 状态。本链按同因止损停止，不再换题或重试。

### 6.3 OpenAI 缺料负例 O：真实语义早停通过

- 部署条件改变后，只对 `run-28eca6a0-e69d-4cd4-9d26-b0c865c3b469` 做一次受控恢复。有效新执行为 creative-treatment producer 1 次 + 独立 audit 1 次；约 103 秒后首次审计即 `needs_source`，没有进入编剧，媒体/TTS 增量 0。
- 页面保留模型原审计的 91 分及原意见，同时由 hostReadiness 具体列出同一保温杯、温度计、连续录像、逐分钟读数和测试条件等五类当前流水线不可取得的材料；高分没有覆盖开工前提。OpenAI Broker最终 `completed=14,failed=0`。截图：`34-openai-negative-needs-source.png`。
- 在 OpenAI/ZAI Broker 均 `active=0,queued=0` 时正常重启 Studio，原始缺料原因和累计调用信息保留。第一次手工重启漏带两个 socket 环境变量，立即识别并撤回该观察；随后按正式脚本显式传入两个绝对 socket 重启，未把部署偏差写成产品问题。截图：`35-openai-negative-after-studio-restart.png`。

### 6.4 生成正例 A：恢复依赖缺口、报价与授权

- `run-e72cd051-e83c-4a9f-8cc8-5a4d2ae70b6f` 先前在 GLM 完成 treatment/script/director 后因旧部署的 OpenAI asset-rank 快速失败；之后用户界面曾把脚本阶段模型保存为 `gpt-5.6-sol` 并令 run stale。
- 在绝对 workspace 与双 socket 的正式环境中点击唯一合法“按人工版本继续生成”后，系统直接复用了旧 GLM treatment/script/director，首个新请求是 OpenAI asset-rank；因此“脚本改为 OpenAI”没有让脚本阶段重跑，实际调用仍显示旧 `glm-5.3`。这是 V9-06 的真实失败证据，不是模型标签问题。
- asset-rank producer/audit 成功，run 到达真实报价。报价 5 个镜头、预计/最高 `¥8.75`：MiniMax H3 视频四条 `¥2.00 + ¥2.50 + ¥2.00 + ¥2.00`，Seedream 图片一条 `¥0.25`，每条最多 1 次。报价打开、保持不确认、调整方案表单打开后返回均为 create=0；截图 `36-generated-positive-quote.png`、`37-quote-adjust-form.png`。
- 已根据本轮用户明确授权确认 `¥8.75`，低于新增媒体+TTS `¥50` 止损。授权后 assets 进入 running；初始账本 `meteredCalls=1`、`actualPendingCount=1`、最大暴露 `¥8.75`。媒体执行及最终结算仍在继续观察。

### 6.5 最终代码构建后的合法恢复与增量报价

- 最终构建于 21:41 安全部署：OpenAI Broker PID `15927`、ZAI Broker PID `15928`、Studio PID `15929`，三个 cwd 均为本仓库；两个 Broker 从 `active=0, queued=0, completed=0, failed=0` 开始，并发布相同的 10 份最新合同。OpenAI 为 `gpt-5.6-sol / xhigh`；ZAI 文本为 `glm-5.3 / max`、视觉为 `glm-5.3-flash`。
- `run-e72cd051-e83c-4a9f-8cc8-5a4d2ae70b6f` 在新 `visual-review` 合同下仍由正式页面提供“重试失败步骤”。条件已由旧 digest 拒绝变为新合同接受，因此只执行一次受控恢复；系统复用镜头 2，没有再次购买，已记录费用保持 `¥2.50`。恢复前证据：`39-new-contract-recovery-ready.png`。
- 恢复约 1 分钟后进入新的正式费用确认，不再显示旧字段合同拒绝。剩余镜头报价为 `¥6.25`：镜头 1/3/4 的 MiniMax H3 各 `¥2.00`，镜头 5 的 Seedream 图片 `¥0.25`，最多 1 次。页面按保守暴露口径把原授权 `¥8.75` 全额计入“已发生/在途”，所以要求追加 `¥6.25`、累计授权 `¥15.00`；实际已记录消费仍为 `¥2.50`，待确认是否扣费 0、付费失败 0。
- 该页真实提供“同意追加并继续 / 调整方案 / 暂不继续”三动作。390px 下 `clientWidth=scrollWidth=bodyScrollWidth=390`，console error 0；证据 `40-incremental-quote-mobile.png`。浏览器全页长截图的 sticky 区块出现重复拼接，宽度测量与可操作控件本身正常，该截图现象不作为产品缺陷。
- 当前停在追加 `¥6.25` 的最终确认点。新增后最大实际媒体/TTS 支出仍不超过本轮 `¥50` 止损，但该浏览器动作会触发真实外部媒体费用，等待动作时确认后再点击；未确认前没有新增 create，也没有把报价当成消费。

### 6.6 追加授权与当前唯一付费任务

- 用户在当前执行窗口明确回复“同意追加”。随后只在原 run 的正式页面执行一次“同意追加 ¥6.25 并继续”，没有更换 run、requestId、模型或重复提交。paid operation 为 `run-e72cd051-e83c-4a9f-8cc8-5a4d2ae70b6f-assets-operation-0d3e2297-f9bc-428a-9731-42a570eeca74`，`requiresManualReconciliation=false`。
- 账本只读核对：镜头 2 复用已完成 MiniMax 任务 `441344555413800`，已确认费用 `¥2.50`；镜头 5 Seedream 任务 `seedream-1789307958-f862c72b5e04` 已完成，已确认费用 `¥0.25`；镜头 1 已提交 MiniMax 任务 `441361211245050`，按配置费率暴露 `¥2.00`，但页面已将其归为“待确认是否扣费”；镜头 3、4 仍为 prepared，尚无 taskId。当前已确认 `¥2.75`，另有在途/待确认 `¥2.00`，总暴露 `¥4.75 / ¥50.00`。API 此时仍为 `requiresManualReconciliation=false`、建议 `resume_original`，尚未要求人工对账。
- 页面运行约 17 分 22 秒时仍显示“素材导演正在处理画面”，且“已记录费用”只显示 `¥2.50 + 1 笔待确认`，没有投影已完成 Seedream 的 `¥0.25`。这证明运行中费用/逐镜进度存在可见滞后；尚不能据此判断最终节点完成后是否会自动纠正。
- 后续原 paid operation 正常完成：5 个镜头全部 materialized，实际费用 `¥8.75`，待确认是否扣费 0、付费失败 0、`requiresManualReconciliation=false`。镜头 1/3/4 的新 MiniMax taskId 分别为 `441361211245050`、`441366502220234`、`441366502220242`；没有重买镜头 2。正式 workflow 随后把 `assets` 标为 succeeded 并推进到 `asset-source-review`，证明不是只把 Provider 结果留在账本。

### 6.7 素材阶段耗时分解与预检原任务恢复

- `assets` 从 21:51:21 到 22:12:02，共 20 分 41 秒。文件与审片记录的 mtime 将耗时拆开：复用镜头 2 后的首个 GLM pilot review 于 21:59:10 完成，约 7 分 49 秒；Seedream 镜头 5 于 21:59:18 物化，约 8 秒；第二个 GLM pilot review 于 22:06:21 完成，约 7 分 03 秒；MiniMax 镜头 1/3/4 分别于 22:08:25、22:10:29、22:12:02 物化。随后直接查询三个原 MiniMax taskId 的正式 v2 状态，均为 `succeeded`：Provider 内部 created→updated 分别为 112 秒、115 秒、86 秒，本地下载/校验另约 11 秒、8 秒、7 秒。
- 因此本次素材阶段约 15 分钟耗在两次正式 GLM 视觉 pilot review，而不是图片/视频 Provider 失败。正式 MiniMax 文档只承诺异步状态 `processing/success/failed`，没有公开固定 SLA；项目实现对每个 MiniMax H3 原任务按 15 秒轮询、20 分钟 deadline，且只查询已有 taskId。Seedream 为同步生成接口；本次实测约 8 秒。当前 voice provider 是本地 `macos-say-v1`，不是付费云 TTS；若 20 秒成片的本地配音持续数分钟，应按本地 worker 异常调查，不能继续无界等待。
- `asset-source-review` 从 22:12:02 开始，约 6 分钟后页面显示 `accepted_unknown`：“已保留原模型任务”，并提供“查询原任务”。证据 `42-source-review-accepted-unknown.png`。只点击一次查询后，恢复文件仍为相同 `taskIdentityDigest=90bf86f065c2e138fcd58fca0d56e401053c50d265c571ad3efe64d0ec7fb7f6`、`taskState=running`，文案更新为“原模型任务仍在处理中；查询不会重新提交或消耗新的创作轮次”；ZAI Broker 仍为 active 1、queued 0，没有创建第二个任务。后续以该 Broker 的 20 分钟正式超时为硬止损，不再重复查询。
- 两份 pilot review 的 trace 进一步解释了慢点：第一份仅一轮、无 retry，模型等待约 243 秒，输入/输出合计 41,633 tokens；第二份同样仅一轮、无 retry，producer 等待约 269 秒，输入/输出合计 19,997 tokens，随后独立 audit 约 152 秒。这里“最多 3 轮”只限制修订轮次，并没有限制单次 producer/audit 的墙钟时间；本次没有发生三轮反复，但一轮仍可包含生成报告与独立审计两次长调用。该拆分是后续耗时解释与容量优化的直接依据。
- 全量 `asset-source-review` 第 1 轮在约 14 分 25 秒后被独立审计要求修订：producer 等待 `504,277ms`，22,994 输入 tokens、19,629 输出 tokens；audit 等待 `361,073ms`，25,010 输入 tokens、14,790 输出 tokens；两次 `queueWaitMs=0`，结构修复 0。慢点是两个大上下文真实视觉模型调用，不是排队、网络重试或三轮已耗尽。
- 第 1 轮审计的 blocking 根因不是“候选不足”：实际镜头 2/3/4 已明显发散成不同空间、卡片形态与色板，而导演方案没有 reference image/母片复用等一致性机制。候选报告却把它归因为可重复购买解决的单镜素材未命中。审计要求保留单镜失败，同时把跨镜一致性根因指向 `visual-direction/script` 并走 `replan_upstream`，不得继续对同一角色反复购买素材；另有一项 scene 1 文字描述与 finding 不一致的 advisory。当前第 2/3 轮只是在修正审片报告的责任归因，不是重新生成媒体，费用仍为 `¥8.75`。若第 2 轮仍因同一归因冲突被退回，应按本轮止损记录为不能继续，而不把第三轮当成默认承载能力。

### 6.8 预检终态、调整方案与模板优先级复现

- `run-e72cd051-e83c-4a9f-8cc8-5a4d2ae70b6f` 的 `asset-source-review` 第 2/3 轮最终正确把跨镜一致性根因路由到 `visual-direction` 并以 `replan_upstream` 有界停止；没有启动第 3 轮、没有再次购买媒体。页面保留 5 场景 13 帧审查、逐镜问题、已有素材和 `¥8.75` 实际费用，并在配音与渲染前停止。说明正式工作流消费了预检结果；但新片仍未进入 TTS、渲染和双成片审片。
- 页面提供“重新检查已有试片”和“调整方案后重新制作”。没有在输入未变化时重跑旧预检；按用户明确要求使用后者，原 run 派生 `run-66e84d3e-4ecb-4e36-ac58-cc0590e5de05`，将镜头 1–5 全部纳入修改，要求一条 15 秒 MiniMax H3 连续母片、镜头 2–4 复用同一母片连续区间，镜头 5 沿用/延长静态结尾。此前 `run-1dd80478-bff5-499f-8046-84c38aa221d8` 的 18 秒结果已核实为 QA 只授权修改镜头 1–4、系统正确保留镜头 5 原 3 秒所致，不是校验器错误；页面已经提示文字要求不能替代镜头勾选。
- `run-66e84d3e-4ecb-4e36-ac58-cc0590e5de05` 在 3 分 47 秒、导演前期构思 producer + audit 共 2 次真实执行后 `needs_source`：模型把五个明确的主观抽象示意全部指向不可用的图库来源，忽略“全部画面可 AI 生成”的用户要求。未进入编剧、报价或媒体。
- 第一次条件改变后的受控恢复 `run-e1d213cd-1267-4116-b30f-44b27df8445b` 明确禁止图库，并写入一条 15 秒视频母片加一张 5 秒静态图。导演构思通过后真实交给编剧；编剧审计在总计 6 分 12 秒、4 次真实执行后 `needs_user`，具体原因是“知识解释”模板的必需知识职责与锁定的主观隐喻冲突，并错误认为两个独立生成母片之间需要同对象连续匹配。
- 第二次条件改变后的最终受控恢复 `run-d514e218-b8fd-4fa3-b00b-045954747991` 明确规定模板只借节奏、不继承证据职责，且 15 秒视频经白闪/淡出切到独立静态图，不要求对象连续。导演前期构思 producer + audit 共 2 次、2 分 15 秒后仍以同类 `needs_source` 停止，要求上传/实拍可追溯真实素材。相同根因已复现，按止损规则停止该链，不再换措辞或第三次重试，新增媒体/TTS费用仍为 `¥0.00`。
- 页面截图 `43-template-priority-needs-source.png`；三个派生 run 的 accepted_unknown 均只查询原任务一次，查询确认 task 仍在处理、没有重提或增加轮次。实际调用与页面阶段变化证明修改要求进入了正式规划链，而不是只保存表单；真实结果同时证明 W1/W2 的模板适配语义仍未通过。

## 7. 暂停时问题清单、费用与验收边界

用户于上述复现后要求停止修复和真实测试。本节只汇总已经取得的证据；没有继续调用模型、购买媒体、执行 TTS 或修改产品代码。

| 严重度 | 问题 | 已证实证据与影响 |
| --- | --- | --- |
| High | 模板默认职责覆盖用户明确要求 | `run-e1d213cd-1267-4116-b30f-44b27df8445b` 已明确只借模板节奏、不主张知识事实，编剧审计仍用“知识解释”模板职责要求补知识/证据。用户锁定的主观情绪短片被模板默认值改写，W1 未通过。 |
| High | 普通生成示意被误判为缺真实来源 | `run-66e84d3e-4ecb-4e36-ac58-cc0590e5de05` 与 `run-d514e218-b8fd-4fa3-b00b-045954747991` 均明确允许 AIGC、禁止事实主张，仍被要求上传、实拍或使用不可用图库并以 `needs_source` 停止。W2 的可制作正例未通过。 |
| High | 连续性语义误判 | `run-e1d213cd-1267-4116-b30f-44b27df8445b` 的“一条 15 秒视频母片 + 一张独立 5 秒静态结尾”被审计解释成两个生成母片必须保持同对象连续匹配；白闪/淡出的明确转场边界没有消除误判。 |
| High | 导演原方案没有在付费前建立跨镜一致性机制 | 主 run 的四条独立视频生成后，空间、卡片形态和色板明显发散。画面预检最终正确上推到 `visual-direction/script`，但导演方案及前置审计没有在 `¥8.75` 媒体执行前要求 reference image、同一母片复用或等价机制。风险发现过晚。 |
| Medium | 页面调用次数和进度解释不可信 | 图库正例受控恢复真实完成 12 次 OpenAI 调用，页面仍只显示旧的 2 次失败；主 run 的前序 treatment/script/director 与视觉审片调用也没有完整汇总。用户无法从页面判断当前是第几次模型执行、结构修复还是审计，以及总耗时花在哪里。 |
| Medium | 单轮视觉调用过慢，轮次上限不能代替墙钟止损 | 两次 GLM pilot review 合计约 15 分钟；全量预检第 1 轮 producer `504,277ms`、audit `361,073ms`，合计约 14 分 25 秒，且 `queueWaitMs=0`、无结构修复。慢点是大上下文真实视觉调用，不是媒体 Provider、候选不足或三轮反复。产品需要按任务类型给出可解释的预期时间、墙钟超时和人工介入点。 |
| Medium | 返工原因对用户过于技术化 | 页面将 `Joint creative planning stopped (...)`、内部责任归因和长审计原文直接暴露，缺少“哪里不具备继续条件、系统已经做了什么、用户现在可选什么”的简明决策说明。 |
| Low | 镜头勾选范围与自然语言修改要求容易产生误解 | `run-1dd80478-bff5-499f-8046-84c38aa221d8` 的 18 秒是 QA 只勾选镜头 1–4、系统正确保留镜头 5 原 3 秒所致，并非校验错误。现有提示仍不足以让用户一眼理解：文字中的“20 秒”不会自动扩大未勾选镜头范围。 |

### 7.1 待产品决定：审计/修订容量与人工介入

- 本轮没有自行实现“单条视频每角色终身三次”的限制，因为 revision 9 资料明确禁止未经确认加入该产品规则。
- 用户提出的待定方向已记录：以单个视频、单个角色节点为粒度，总机会可考虑限制为 `1 次自动创建 + 2 次审计/修订`；耗尽后不重新申请新的三轮，而是明确列出失败节点、已尝试内容和仍缺条件，转人工介入或让用户选择自行提供/生成图片等替代路径。
- 当前证据说明还需要把“轮次上限”和“单次墙钟时间”分开设计：本次全量预检只进行了一轮 producer + audit 就耗时约 14 分 25 秒。即使最多三轮，若没有单次耗时阈值、进度解释和人工接管入口，用户仍会感觉系统无止境等待。

### 7.2 费用、已排除项与未验证项

- 本轮实际媒体费用最终为 `¥8.75 / ¥50.00`；TTS `¥0.00`，无待确认费用、付费失败或人工对账。停止后没有新增调用或支出。
- OpenAI `process_exit` 已证实是 QA 手工部署使用相对 workspace 路径造成；改为绝对路径后正式 OpenAI 任务成功运行。该项是部署偏差，不列为产品代码缺陷。
- 正式 workflow 已消费 5 个素材结果并从 `assets` 推进到 `asset-source-review`；预检结果也被消费并以 `replan_upstream` 停止，因此不能把“FakePipeline 收到调用”当作证据，也没有这样做。
- 未验证：TTS、渲染、新成片、同一 evidence SHA 的 OpenAI/GLM 双真实模型独立审片、审片驱动局部返工、最终人工批准，以及成片画面、声音、字幕、节奏和内容兑现。主 run 停在配音前，不能宣布完整生产链或产品验收通过。
- QA 状态为 `PAUSED_BY_USER`：问题与证据已记录，等待统一审查或后续明确恢复；不是 `READY_FOR_REVIEW`、`ACCEPTED` 或“全链路可用”。
