# 验收矩阵

## A. Topic 合同

| ID | 验收要求 | 必须证据 |
| --- | --- | --- |
| TC-01 | Studio 与 Broker 使用同一 canonical `strategy`；无永久双字段兼容 | payload × parser 跨进程测试 |
| TC-02 | `generationNonce` 不进入模型 payload，只影响生成轮次/request identity | payload 与 requestId/checkpoint 断言 |
| TC-03 | strategy 长度、schema、validator、descriptor、digest 一致 | 边界值与 digest mismatch 测试 |
| TC-04 | `topic-ideas` 纳入合同摘要保护 | health contract + client expected digest 测试 |
| TC-05 | 模型失败的规则回退有结构化诊断，不冒充模型成果 | service/API/UI 测试 + 浏览器证据 |

## B. Broker 受理与查询

| ID | 验收要求 | 必须证据 |
| --- | --- | --- |
| BR-01 | POST 只有 durable acceptance 成功后才返回 accepted/202 | durable barrier 测试 |
| BR-02 | 查询同一 requestId 只读取 record，不调用 queue/executor | executor count=0 的 query 测试 |
| BR-03 | queued/running/completed_success/completed_failure/accepted_unknown 可结构化区分 | route/parser 测试 |
| BR-04 | completed outcome 可重复读取且 byte/identity 稳定 | repeated query 测试 |
| BR-05 | completed record 核验先于临时 session registry 依赖 | missing registry 集成测试 |
| BR-06 | digest/kind/session/contract conflict fail closed | 409/结构化 reason 测试 |
| BR-07 | 查询失败不改变任务事实 | transport fault 测试 |

## C. Studio / pipeline 恢复

| ID | 验收要求 | 必须证据 |
| --- | --- | --- |
| RC-01 | 首次提交前 checkpoint 保存不可变 request binding | checkpoint 内容测试 |
| RC-02 | 断连后只查询原 requestId，不 produce、不 fallback | 跨进程丢响应测试，executor=1 |
| RC-03 | completed success 取回 output/trace/session 并继续原节点 | role-loop/pipeline 集成测试 |
| RC-04 | completed failure 显示真实终态，不无限轮询 | terminal failure 测试 |
| RC-05 | 只有权威 not_accepted 才允许新的有界尝试 | requestId/attempt 计数测试 |
| RC-06 | generation、sessionRebuilds、模型尝试不会因查询增加 | checkpoint before/after 对比 |
| RC-07 | 暂停状态不会被查询结果自动解除 | service + UI 回归 |
| RC-08 | 旧 uncertain run 可读取原 durable outcome；无法验证时安全停住 | 四条失败 run 关联报告或受控等价 fixture |

## D. 错误与用户体验

| ID | 验收要求 | 必须证据 |
| --- | --- | --- |
| UX-01 | 任务事实与观察错误分开，不再把所有失败写成“连接中断” | error matrix 单测 |
| UX-02 | 服务端提供结构化 `allowedActions` | shared DTO/API 测试 |
| UX-03 | unknown/running/completed/query failure/not accepted/conflict 显示正确按钮和结果 | 组件测试 + 1440/390 截图 |
| UX-04 | 所有按钮实际调用正确 API，不能出现秒败死胡同 | 浏览器点击记录 |
| UX-05 | 12 条 blocked+pending 不称“总编已评估” | 组件 fixture + 浏览器证据 |
| UX-06 | capability ready 与 recent task health 分开 | API/组件测试 |
| UX-07 | 文案同时说明发生什么、保留什么、下一步 | 人工审阅 + 浏览器截图 |

## E. 安全、费用与原有能力

| ID | 验收要求 | 必须证据 |
| --- | --- | --- |
| SF-01 | 同一物理模型请求执行一次 | executor/provider task ID 计数 |
| SF-02 | 未授权媒体 create=0 | ledger + Provider 调用记录 |
| SF-03 | 授权媒体逐笔报价和范围一致，不重复购买 | authorization + ledger + provider receipt |
| SF-04 | 素材失败不生成说明卡 | 失败注入 + UI/产物断言 |
| SF-05 | 双审两个真实模型、同 snapshot、互不可见 | reviewer identity + evidence SHA |
| SF-06 | 补审只补失败分支 | render/voice/media create=0 |
| SF-07 | 局部返工不扩大 | affected set、create set、ledger |

## F. 真实 E2E

至少覆盖三条互补制作：热点入口、系列本集、自有想法。三入口前段各自成立，后段共享正式生产链。

必须覆盖：

1. 选题/规划/脚本/导演方案与可执行时间轴。
2. 报价、人工确认、授权范围、预算不足反馈、调整方案和暂停/恢复。
3. 图库、生成图或生成视频的真实选择与至少一笔合理付费媒体调用。
4. 配音、渲染、时长/帧数/音画同步、0–成片结尾逐段有画面。
5. 两个真实 reviewer 对同一 evidence 独立审片。
6. 用户打回、审片建议预填、局部返工、未受影响成果复用。
7. 1440 与 390 宽度、键盘焦点、错误/恢复文案。
8. 页面刷新与 Studio/Broker 重启后的持久化恢复。

如果第一轮 E2E 发现新问题：先记录完能覆盖的全链问题和原因，再按共同根因集中修复；除非不修就完全无法继续，否则不要立刻碎修。

