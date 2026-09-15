# VideoFactory 第五轮真实本地 QA 报告（revision 6）

- 报告编号：`VF-REAL-LOCAL-QA-20260913-05`
- 日期：2026-09-13
- 模式：`qa-only` / report-only，先测试和记录，不边测边改
- 分支：`codex/final-dual-review-cloud-acceptance`
- HEAD：`570fe6e59e072c4965c86769bf2096825f003383`
- 开始时间：2026-09-13 07:56:46 +0800

## 1. 覆盖表（最终状态）

| ID | 范围 | 状态 | 实际证据 |
| --- | --- | --- | --- |
| E01 | 热点、系列本集、自有想法分别到真实规划/方案/报价 | BLOCKED | 三入口页面均实际进入；热点显示来源不足，系列显示能力缺失，自有想法表单未提交；正式 Broker 合同探针失败，未创建 run/request |
| E02 | 方案修改、报价三动作、暂停和显式恢复 | BLOCKED | 无合法的新规划 run，不能硬改状态或用历史只读 run 冒充；媒体 create=0 |
| E03 | 一条代表性制作完成真实媒体、配音和渲染 | BLOCKED | 未到报价/授权；Provider taskId=无，新增媒体/TTS=0，实际新增支出 ¥0.00 |
| E04 | 两个真实不同模型对同一 evidence SHA 独立审片 | BLOCKED | OpenAI/ZAI Broker 均启动但 Studio 因 taskContracts 不完整 fail-closed；未产生本轮 evidence SHA 或审片任务 |
| E05 | 一次必要局部返工并验证未变成果复用 | BLOCKED | 没有本轮真实审片结果可触发必要局部返工；未人工制造缺陷或扩大重买 |
| E06 | 刷新、暂停/恢复、重启持久化、1440/390、导航/搜索/模板/素材/设置 | BLOCKED | 导航/搜索/素材/模板增改删/设置/1440/390/浏览器刷新/Studio 重启持久化均通过；新 run 暂停/恢复因同一模型阻断未验证 |
| E07 | 逐段看片听声及状态文案可理解 | BLOCKED | 本轮新成片未生成；仅只读核对历史成片 21s/1080×1920、配音 24.02322s、四段画面和“不通过/双审 0/2”文案，不能代替本轮成片验收或实际听声 |

## 2. 本轮支出与止损计划

- 当前新增支出：`¥0.00`；OpenAI/ZAI Broker 启动后 completed=0、failed=0、active=0、queued=0。
- 三个入口只先运行真实文本规划到方案/报价；另外两条原则上停在报价，不重复购买全片。
- 仅选一条题材和报价合理的代表性制作确认媒体支出。每次确认前记录精确报价、Provider、镜头范围和当前费用占用。
- 新增媒体与 TTS 测试消费合计止损线：`¥50.00`。这是 QA 资源上限，不改产品费用设置，也不要求花完。
- accepted/unknown 只查询原任务；同根因同路径仅在前置条件或证据变化时恢复一次。付费结果未知时不发第二笔。

## 3. 正式环境部署证据

- revision 6 最终 production build 完成后，核对旧 PID 29980/29982/29983 均来自本仓库、启动早于最终 build；两 Broker `active=0/queued=0` 后正常 TERM。
- OpenAI Broker PID 42143：正式 `apps/codex-broker/dist/main.js`，provider `openai`，model `gpt-5.6-sol`，capacity 1，storeId `vfs_store_9b7afe63713f2bebffbd7dc97c677bc9`。
- ZAI Broker PID 42144：正式 dist，provider `zai-bigmodel-api`，text `glm-5.3`，visual/asset/reference `glm-5.3-flash`，capacity 1，storeId `vfs_store_e4d1561b08220ce917bf084b6de43f43`。
- 初始 Studio PID 42146：production dist，`http://127.0.0.1:4317`；health `ok`，Python/FFmpeg/ffprobe/say 均 true，但首次启动漏传两个 Broker socket。
- 按正式启动脚本确认配置后，在 Broker `active=0/queued=0` 时正常 TERM 初始 Studio；补齐 `VIDEO_FACTORY_CODEX_SOCKET_PATH=.local/runtime/codex/worker.sock` 与 `VIDEO_FACTORY_ZAI_CODEX_SOCKET_PATH=.local/runtime/zai-codex/worker.sock`，重启为最终 Studio PID 59645。最终 health 仍为 `ok`，历史 run、登录会话与媒体均可读；没有重启 Broker。
- 两个 storeId 与重启前一致；没有删除/迁移 durable、checkpoint、历史 run，没有挂 fake/mock/fixture，没有输出凭据。

## 4. 测试日志与问题记录

### QA-R6-01：正式 Broker health 宣称 10 类任务，却只发布 5 类 contract digest（产品阻断）

- 时间：2026-09-13 08:53–09:04 +0800。
- 入口：创作设置 → 制作分工 → 刷新能力状态。
- 预期：OpenAI `gpt-5.6-sol` 与 ZAI `glm-5.3` / `glm-5.3-flash` Broker 已启动，Studio 的正式创作/审片角色应显示可用。
- 实际：`/api/providers` 返回 `api-topic-editor-v1`、`codex-series-showrunner-v1`、`codex-screenwriter-v1`、`api-visual-director-v1`、`codex-creative-treatment-v1`、`codex-reference-grammar-v1`、`codex-asset-ranker-v1`、`glm-visual-review-v1`、`codex-visual-review-v1`、`codex-role-auditor-v1` 均为 `available=false,status=needs_config`；页面显示“AI 编剧 · 不可用”“AI 视觉导演 · 不可用”“GLM-5.3-Flash 视觉审片 · 不可用”。刷新一次后不变，console error=0。
- 首次部署问题：Studio PID 42146 的启动命令漏传两个 socket，因而回落到 `/run/video-factory-*/worker.sock`。该问题已先记录，再按仓库正式启动脚本，在两个 Broker `active=0/queued=0` 时正常重启 Studio 并补齐两个 socket；这是前置条件明确变化后的唯一一次有目的恢复。
- 恢复后的原始错误：两个 socket 被准确识别，但 `/api/providers` 仍返回“使用了不兼容的协议版本”。两个 Broker `/health` 均声明 `protocolVersion=video-factory/codex-bridge-v2`、10 个 `taskKinds`，却只返回 `visual-review`、`role-audit`、`creative-treatment`、`topic-ideas`、`script-draft` 5 个 `taskContracts`。
- 已证实根因：`packages/production-pipeline/dist/codex-chat.js` 的 `REQUIRED_CODEX_TASK_CONTRACT_DIGESTS` 要求 10 类 digest；`apps/codex-broker/src/broker-server.ts` 与正式 dist 的 health 白名单仍硬编码上述 5 类。Studio 的 `isCompatibleTaskContracts` 对 Broker 自称支持但缺 digest 的任务 fail-closed，行为正确；正式 Broker health 合同不完整。
- 已排除：两个 Broker 未启动（两个 socket health 200）；socket 路径/权限（Studio 已连接并返回协议错误）；页面缓存（刷新能力状态与 Studio 重启后相同）；构建时间漂移（pipeline、Broker、Studio dist 均为 07:52 的本轮 build，Broker source/dist 逻辑一致）；HTTP/前端脚本故障（相关 API 均 200，console 0 error）。
- 影响：E01–E05 和 E07 的新增真实模型/成片路径 BLOCKED；未创建 run、未提交 request、媒体/TTS 增量=0、费用增量=¥0.00。同根因不再重启或重投，未在 QA 中修改 Broker 产品代码。
- 截图：`videofactory-real-local-qa-20260913-05-assets/09-settings-1440.png`（设置首页）、`videofactory-real-local-qa-20260913-05-assets/16-provider-contract-mismatch-1440.png`（最终 Studio PID 59645 的制作分工页，AI 编剧、视觉导演和 GLM 视觉审片均显示不可用）；同时由 accessibility snapshot 与 `/api/providers` 响应记录佐证。

### 已完成的独立浏览器检查

- 登录与首页：qa-local 正式登录成功；首次导览可提前结束，首页恢复可操作；截图 `01-initial-1440.png`–`05-home-no-guide-1440.png`。
- 制作记录：搜索“QA 手动选题”只返回对应记录；截图 `06-projects-search-1440.png`；console 0 error。
- 素材库：按作品展示 43 项素材，搜索“六秒光影”精确收敛到对应作品，空搜索显示清除筛选入口；截图 `07-assets-by-project-1440.png`；console 0 error。
- 模板工坊：仅创建本人 `QA R6 临时模板 20260913`，修改名称/说明并保存草稿，随后确认删除；API 依次 POST 201、PUT 200、DELETE 200，删除后回到 6 个内置模板；截图 `08-template-edited-1440.png`；console 0 error。
- 390 宽度：首页顶栏和底部导航可用，主内容无横向溢出，入口卡片可见；截图 `10-home-390.png`；console 0 error。
- 三入口：热点样本全部明确显示“待补来源 · 当前不可开工”，当前候选要求至少两个不同域名的有效原始来源；未刷新同一失败题目，截图 `11-hotspot-source-blocked-1440.png`。系列页可选择系列/本集，但“新建制作”禁用并提供“查看缺失能力”，截图 `12-series-capability-blocked-1440.png`。自有想法手动录入与 JSON 导入表单可打开；为避免在已知模型阻断下制造无效记录，未保存机会。
- 全局搜索：“六秒光影”返回两条对应历史制作且状态分别为“已打回/失败”；截图 `13-global-search-1440.png`；console 0 error。
- 刷新与 Studio 重启持久化：历史 run `run-b6604f47-0498-4fb6-bd9c-9f0141c98815` 在浏览器 reload 后 URL、历史只读、不通过、双审 `0/2`、费用记录不变；Studio 正常重启为 PID 59645 后同一登录会话和历史 run 继续可读，截图 `14-historical-review-state-before-refresh-1440.png`；console 0 error。

### 历史成片只读检查（不计作本轮 E03–E05 通过）

- 浏览器真实加载的最终视频：1080×1920，duration=21s，readyState=4；独立生成片段 1366×768，duration=5.875s；配音 duration=24.02322s，readyState=4。
- 对最终视频实际 seek 到 0.5/6.5/12.5/18.5 秒并截图：`15-historical-final-00s.png`、`15-historical-final-06s.png`、`15-historical-final-12s.png`、`15-historical-final-18s.png`。首段是水杯实景，后续三段主要是文字模板卡，和历史审片“原理/验证/结论视觉未兑现、实际 21 秒短于目标 24 秒”的结论相符；没有把页面模型评分替代人工画面观察。
- 浏览器媒体技术信息证明视频/音频可加载，但本执行窗口无法实际听见扬声器输出，因此“声音内容与同步”仍为 NOT_VERIFIED；未把 readyState 或旁白文本冒充听声证据。

## 5. 慢问题、费用与停止条件

- 本轮没有提交任何真实模型、媒体或 TTS task，因此没有 run/node/request 的 produce/audit 分段耗时；Broker counters 始终 completed=0、failed=0、active=0、queued=0。
- 可独立 UI 请求中，热点信号约 0.3–2.6s，voices/local-capabilities 等约 0.4–1.34s；未见超过当前等待窗的页面请求。浏览器控制工具曾因仓库写权限无法创建 `.gstack` lock 而报告“Another instance is starting”，以批准的同一正式浏览器命令连接后恢复；这不是产品问题。
- 新增媒体/TTS 实际支出：`¥0.00`；未出现报价、授权、Provider taskId 或 unknown 付费结果；¥50 止损线未占用。
- 停止原因：同一合同缺失根因在一次有目的部署恢复后仍确定存在，继续创建 run 或重启无新证据；按 TASK 不盲目重试、不边测边改，停止模型/付费链并交审查窗口安排集中修复。

## 6. 问题清单与建议

1. `QA-R6-01`（P1，阻断）：Broker `/health.taskContracts` 应与它声明支持的 10 个 `taskKinds` 和 `REQUIRED_CODEX_TASK_CONTRACT_DIGESTS` 同步，至少补齐 `series-roadmap`、`director-plan`、`publish-copy`、`asset-rank`、`reference-grammar`。修复后先做 Broker health parser 聚焦测试，再重新部署并仅恢复一次 E01。
2. 热点来源不足不是假成功：当前 UI 已明确要求补充原始来源，行为符合人工介入预期；不要通过刷新同题或生成画面绕过来源门槛。
3. 本轮未验证：新 run 的真实规划/方案/报价，三种报价动作，暂停/显式恢复，真实媒体/TTS/渲染，双真实模型同 evidence SHA，必要局部返工，实际听声与新成片同步。以上均不得据此报告为 PASS。

未 commit、未 push、未云端部署、未发布视频、未删除 durable/checkpoint/历史 run，未读取或输出凭据。
