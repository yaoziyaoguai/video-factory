# 当前实现审查：不能据第三轮报告直接放行

任务：`VF-R3-CLOSURE-20260912-01`，2026-09-12。基线与文件摘要见 BASELINE.json。

## 结论和证据边界

当前实现仍有需要优先修复的跨层合同问题。**保留现有架构，补齐任务事实与恢复闭环；不推翻流水线。** accept/poll 的方向正确，但短查询接口并不自动带来幂等、身份校验、重启恢复和正确用户动作。

本次独立运行：

- 前执行者新增的 topic/script + recovery 测试：10/10，exit 0。
- 既有 session/idempotency/lifecycle 聚焦测试：7/7，exit 0。
- 新增隔离审计探针 P01–P12：0/12，exit 1，无 timeout/skip/cancel。
- git diff --check：exit 0。
- Studio `/api/health` 曾返回 ok；这不证明实际模型、工作流或成片通过。

本轮没有调用真实模型或媒体，没有付费，没有重跑全量，没有做真实浏览器 E2E，没有新调用 Oracle，也没有改产品源码。历史全量通过是前执行者的报告，不是本轮独立验证。此次只新增资料和隔离审计测试。

## 1. 受理没有排他性，后台失败又可能拖垮整个 Broker

### P02：同 ID 并发多次执行，P1

位置：`apps/codex-broker/src/broker-server.ts:458`，`acceptDurableTask()`。

`idempotentTasks` 的第一次检查之后，跨过 mkdir/read/write 的多个 await，才 set 在途条目。多个提交同时读到“不存在”，各自落盘 accepted，再各自进入 executor。atomic rename 只防文件半写，不提供“第一位受理者”的互斥。

隔离测试同时 POST 12 个相同请求，最新保存证据中 executor 执行 **12 次**；此前复跑出现 8–9 次，调度会影响次数，但均违反最多一次。测试使用受支持的 concurrency=16/maxBacklog=32，并非声称正式环境正运行在此配置。这里验证的是文本 Broker 重复执行；没有证据证明已经重复扣了媒体费。

同一代码的 active/previous 分支还把外部 lookup 当成已核验保证，没有在互斥范围内重新比较 digest；不同绑定并发也必须补测。

违反：旧 BR-01/06、SF-01。最低修正：任何 await 前建立 per-request 排他/共享 promise，并在锁内重读、重验绑定；落盘成功才调度。单目录必须有明确单 owner，不能靠降低并发掩盖。

### P12：后台完成落盘失败导致进程退出，P1

位置：同文件 `acceptDurableTask()` 的 `void outcome.finally(...)`、`executeDurableTask()`、`writeIdempotencyRecord()`。

隔离子进程在 accepted 后注入临时完成文件 rename 失败，Node 因 unhandled rejection exit 1。影响不是一个任务显示失败，而是可能使同 Broker 的其他任务中断。

最低修正：完整跟踪并捕获后台完成 promise 的失败，区分权威完成记录写失败与派生 session 索引失败。保留未知/存储故障证据，禁止重放，不伪造成功。close() 目前只等 queue，尚未实证其 shutdown 丢写，但必须补子进程关闭窗口测试。

## 2. 查询接口没有验证原任务，返回也会丢信息

### P03 / P11：查询与返回绑定不完整，P1

位置：`broker-server.ts:403`，`codex-chat.ts:419`、`:560`。

GET 仅按 requestId 返回结果，没有核对原 kind、payload/session digest、合同和存储/Provider 身份。客户端 parseEnvelope 也不核原 requestId：代理将 completed.requestId 改成另一个合法 ID，客户端仍接受。

这是内部任务关联完整性问题，不是已证明的公网越权。Unix socket 权限不能替代原任务绑定。

最低修正：提交前持久化原不可变绑定，查询请求和响应都校验；不能使用只有收到 202 才知道的随机票据作为唯一恢复凭证，否则丢回包仍无解。

### P01 / P07：轮询丢 session，缺派生索引时恢复不完整，P1

位置：`broker-server.ts:425`，`materializeSessionRecord()` / `resolveSessionId()`。

- GET 从 `record.sessionHandle` 读取，但实际 handle 在 `record.outcome.sessionHandle`。真实 client + broker 测试返回 result.session=undefined，而 durable outcome 有合法 handle。
- POST replay 会从完成记录补 session registry，GET 不会。只删除临时派生索引后，GET 未恢复它。

旧 session 测试经过 POST replay 或非 durable 路径，所以能通过。最低修正：同一完成结果通过 POST/GET 均保留 output/trace/session；能从权威完成证据恢复后续会话，模型调用增量为 0。

P07 现有探针检查“GET 后索引文件存在”，只是当前实现路径的复现方式。正式验收可以采用下一次 resolve 从完成记录恢复的等价方案，核心是连续会话行为正确，不能把某个缓存文件存在当唯一业务标准。

## 3. 任务事实、查询故障、终态失败混成一种错误

### P04：accepted 遗留记录永远显示 running，P1

位置：`broker-server.ts:423`、`executeDurableTask()`。

没有本进程执行者的旧 accepted record 也显示 running；executor 已退出且 outcomeUncertain 的任务同样只保留 accepted。没有 `accepted_unknown` 的真实投影。

隔离测试种入 v1 accepted record，无 executor 调用，却返回 running。旧测试还明确把 uncertain → running 写成期待值；不能把这种断言当合同正确。

### P05 / P10：受理后的观察失败可能退成未受理，丢回包又不主动取回，P1

位置：`codex-chat.ts:230`、`:281`、`:745`。

- 已收到 202 后，查询入口出现 ENOENT/ECONNREFUSED，被映射为 transient not_accepted，并从轮询 catch 直接抛出。这可能让上层重提或切 backup。
- POST 实际已落盘且执行，唯独响应被丢弃，client 没有尝试 GET，查询次数为 0，已有结果不能取回。
- 所有 404 被视为权威未受理；错误 Broker、非 durable 配置或错目录的 404 显然不能证明原任务没执行。该静态分支需补负向测试。

最低修正：任务事实和观察错误分别记录。凡有可能已送达或已经 accepted，连接错误/裸 404 都不允许退回 not_accepted。原查询不能回到提交/fallback 循环。

### P06：已完成失败仍被包装成 uncertain，P1

位置：`codex-chat.ts:347`，`mapFailureResponse()`。

真实 Broker 持久化 completed、ok=false、status=500 后，GET 200 信封被 client 再按提交 HTTP 错误分类成 uncertain。应以已核验的任务终态为准，内部 500 是失败原因，不是查询连接状态。

### P08：新增错误类型没有贯穿 fallback，P1 边界缺陷

位置：`packages/production-pipeline/src/model-fallback.ts:31`；`codex-chat.ts:689`。

fallback 仅优先拦 uncertain，没有优先拦 rejected/conflict。受控组合 rejected/conflict + network category 被判可换模型。不是声称正常所有 409 都会带 network，而是“身份冲突绝不切备选”的不变量在边界组合失效。

另外 parseModelCandidateAttempts 仍只认旧 stage，新增 rejected/conflict trace 会被拒。错误类型不能只在顶层 union 增加两个名字。

## 4. 恢复仅做到 client 内部，未落到用户真正操作的链路

以下为当前源码静态确认的实现缺口，尚未在真实浏览器复现全部情形：

- `role-agent-loop.ts:122` 的 checkpoint 保存 request IDs、generation、sessions 等，但没有完整发送 envelope、requestDigest、原 Broker/Provider、待观察阶段和不可变提交快照。重启后再运行 producer 不等于查询原任务。
- `fallback-task-client.ts` 的 sessionAffinity 只是内存 Map。进程重启后无法据此恢复原 Provider 和输入 handle。
- `production-studio.ts:1943` 的 retryFailedNode 仍是普通重试入口；没有文本任务结构化核对/取回操作与约束。
- `RunWorkbench.tsx:374` 仍主要显示“重试失败步骤”；`run-observability.ts:192` 仍从文本推断失败，并把 outcomeUncertain 引导到服务商核账。文本结果取回不是媒体账单核对。
- 暂停、版本变更后晚到结果、多个恢复点击的并发没有真实闭环证据。旧报告“结构上不可能解除暂停”不是测试。

违反：RC-01..08、UX-01..04/07。最低修正见 IMPLEMENTATION；不能只改页面文案或把 GET 改成公开方法就宣布恢复完成。

## 5. 输入合同修法会悄悄损失创作质量

### P09：合法长偏好挤掉定位、受众，P1（内容质量）

位置：`apps/studio/src/server/topic-ideas-payload.ts:19`。

为把拼接策略压到 2000 字符，代码循环 `head.shift()`，先删定位、受众、题材和避开规则。测试传入合法的 customInstruction 1990 字符与定位/受众，后两者未到达模型。

UI 可接受的字段分别为 500/500/1000/1000/2000，完整合法输入本来就可能超过 2000。不是需要把模型调弱或让用户少说，而是输入边界不一致。应完整传递当前所有合法配置，拼接上限统一为 6000（包含标签和来源说明），非法/超限显式报错，不能静默删段。

### 输入保护与测试代表性仍不足

- `task-definitions.ts:915` 的 digest 覆盖 kind/prompt/outputSchema/semanticRulesVersion，**不直接包含输入合同**。这能发现版本标签变化，但输入 parser 改了而版本未改时，保护可能不触发。
- topic builder 位于 Studio，并非 Broker validator 的同一份运行代码；Broker 仍独立写 2000。不要继续称“同一份共享合同已验证”。
- 名称含 cross-process 的测试实际主要为同进程 builder/parser/socket；script brief 是手写对象，不是正式编剧适配器产生的 payload。原 recovery 用例还包括 fake HTTP 和 private query 路径，没有进程重启及正式 role checkpoint。

最低修正：正式输入合同声明纳入摘要，跨包 guard 测试核验真实生产者输出及边界。保留 Broker 独立部署，不为几条合同常量引入跨应用运行时依赖；具体落点见 IMPLEMENTATION 第 6 节。

## 6. 非阻断但同批应收口的用户投影

`TodayPage.tsx:230` 从当前候选 provider 推断“最近一轮真实生成来源”。模型合法返回空候选、旧候选残留、混合来源时，候选集合不能证明本轮调用结果。应取服务端本轮 generation receipt；无证据时显示未知/尚无记录，不能显示假成功。

不要求重做选题界面或增加监控大屏。原来源门禁也不放宽，不能为 E2E 造“高分/来源通过”数据。

## 7. 上轮报告的正确用法

四条历史 run 的 durable/checkpoint 证据支持“编剧输入被 400 拒绝且错误归类”，可作为已经查明的特定根因；不能扩写成所有连接中断都不存在。

前执行者确实修了一部分：topic 字段归一、script brief 白名单扩展、初步 accept/poll 与诊断。问题是验证范围远小于所勾选的验收范围。保留旧报告，不抹历史；RESULT 应以本轮逐项证据纠正完成标签。

未走通的报价 → 媒体 → 配音 → 渲染 → 双审 → 局部返工，仍必须在修复后用正式本地环境验证。不能把“文本合同测试通过”换算成视频流水线通过，也不能据此保证成片质量显著提高。
