# 最小技术修复方案

任务：`VF-R3-CLOSURE-20260912-01`，revision 1。

## 0. 架构决定

保留 React/Fastify、WorkflowRunner、ProductionPipeline、创作规划 LangGraph、现有 SQLite checkpoint、FileRunStore、Broker 文件记录、队列、Provider 和 Python worker。不加 Redis、新数据库、新队列、第二套工作流或另一套费用系统。

本次只补一个跨层事实：**某一不可变请求是否被原 Broker 受理、是否仍在执行、最终结果是什么，以及该结果属于哪个原计划版本。** HTTP 连接状态不是这项事实。

下面字段名可按现有代码惯例微调，但语义、边界和验收不能缩减。不是让执行者再做选型。新增小文件应保护真实模块边界，而不是为每个状态制造抽象。

## 1. 提交身份和结果信封

### 不可变提交快照

在第一次网络提交前，通过现有 role checkpoint 保存 `pendingOperation`。至少包含：

- 原 phase（produce/audit）、iteration、operationKey、generation、所属 run/plan version 或已有 checkpoint key。
- 完整可序列化的原请求 envelope：protocolVersion、requestId、kind、payload、expectedContractDigest、输入 sessionKey/sessionHandle（缺失与空值的规范固定）。
- `requestDigest`：对实际发送的规范 JSON 求 SHA256；必须涵盖 payload、kind、合同、输入 session 和请求 ID。不要摘要一个对象却发送另一个可变对象。
- `brokerBinding`：持久化存储命名空间 storeId、选定 providerId、该 kind 的 modelId，以及本地路由标识。socket path 是路由信息，不单独充当身份凭证。
- 最后已知任务事实与最后观察错误分开保存；后者可有时间和诊断，但不能改写前者。

Broker 的 idempotency 目录首次初始化一个稳定 storeId；进程重启保持，目录换了则不同。health 暴露该 ID、协议能力以及当前 kind 的身份；不包含密钥。首次提交前读取/使用本轮已核对的能力快照并保存预期身份，Broker 再验证预期身份，防止探测后配置变化。

已有 record 的身份按受理时快照保存，不能用“当前所有模型目录”重新算历史 digest。无关模型新增不应让原结果无法取回。原模型现在不再配置，也不妨碍验证原记录；需要继续新执行时才检查当前能力。

查询沿用 `GET /v1/tasks/:requestId`，通过明确的 query 参数或 headers 携带原 digest、kind、storeId、Provider/model 绑定；选定一种固定实现并测试转义。不要把完整 payload 或密钥放 URL。client 必须核验返回绑定，不仅检查 output schema。

所有 accepted/完成/权威拒绝信封都包含同一绑定。新查询合同使用显式 capability/version 标识；新 client 遇不支持该合同的旧 Broker 安全报不兼容，不能悄悄退回旧长请求作为正式生产兜底。

### 结果状态与观察结果

Broker 新 record/查询采用以下可区分语义，现有 `completed + ok` 存储可保留，DTO 统一投影即可：

| 任务事实 | 能证明什么 | 允许什么 |
| --- | --- | --- |
| queued / running | 当前 owner 有实际排队/执行条目 | 查询原任务，不重提 |
| completed_success | 完成记录、绑定、输出均已核验 | 取回原 output/trace/session |
| completed_failure | 原任务确定结束且失败 | 报真实原因；只有现有明确可切模型类别允许有限新尝试 |
| accepted_unknown | 有受理/可能执行证据，无可验证终态或当前执行者 | 保留原绑定，查询/补证；不能重提或换备选 |
| not_accepted | 明确证明本物理尝试未执行且不再可能执行 | 现有有界重试；记录新物理尝试及原因 |
| rejected / conflict | 合同拒绝 / 原身份冲突 | 停止并修正，不自动重提/backup |

`query_failure`、观察超时、socket 不可达、缺/坏信封属于**观察故障**，不是另一个任务事实；在已有事实旁显示。不能根据响应 HTTP=500 就把 completed_failure 改成 uncertain。

## 2. Broker：先排他受理，后执行，完整管理后台结果

### 受理路径

1. 同 requestId 在任何 await 前占据一个共享受理条目/互斥槽；相同绑定等同一 promise，不同绑定直接 conflict。
2. 在排他范围内再次读取 durable record 并比较完整绑定。不能相信锁外 lookup 的结果仍然成立。
3. 已完成：重放原记录；已受理但不在本进程活跃表：返回 accepted_unknown，绝不再 enqueue。
4. 新任务：校验当前合同、身份和输入 session；保存 accepted。写入失败时 executor=0；返回明确存储故障，不能暗示用户反复点击即能恢复。
5. 保存成功才调度队列并返回 202。并发相同提交即使等待首个落盘，也不能各自提交队列。
6. 单目录只允许一个活跃 Broker owner。使用本机文件排他锁/现有可靠锁模式即可，不做分布式锁服务。第二个进程不同 socket 指向同目录也必须启动失败；不要 unlink 活跃 owner 的 socket。崩溃后的 stale lock 只能在证明 owner 已退出后回收，权限/身份不明就 fail closed。这个锁不代表旧 accepted 任务可以重放。

排他锁和请求 Map 各司其职：前者防两进程同时写同库；后者处理同进程并发 POST。只把生产并发设成 1 不算修复。

### 拒绝、未知和退出

- queue 能证明“尚未执行”的 backlog/shutdown/cancel-before-start，保存有绑定的 not_accepted 终结记录，不删除受理证据后用裸 404 充当授权。该记录封住原 ID，不允许随后又执行同一物理尝试；有限新尝试由 client/role 层明确派生并记账。
- executor 一旦可能执行，失联/异常中断无法证明终态时保留 accepted_unknown，不自动重放。HTTP 503 本身不是充分依据，应使用 queue 的结构化执行边界。
- GET 查询也与受理临界区协调，不能在落盘空窗给出“原请求不存在”的错误承诺。
- 找不到记录或非 durable 模式返回“无法核验/不支持查询”，不是权威 not_accepted。即便来自同 storeId，裸不存在也不能证明另一条正在送达的 POST 永远不会执行。
- 已知 accepted 后，记录丢失/目录切换一律 unknown 或 conflict，不降级安全重试。

### 后台 promise 和持久化

- 跟踪所有受理/执行/完成落盘 promise，所有 rejection 必须被消费并留下安全诊断。禁止仅对原 promise catch，却把 finally 派生出来的 rejection 再丢掉。
- 完成 record 是权威事实；派生 session registry 后写失败时，不能把已完成成功抹成未知。返回/后续恢复仍可以用权威记录，索引修复要有错误报告。
- 完成 record 写失败：原 accepted 留存，进程不因未捕获 rejection 崩溃；暴露 storage/query failure，禁止返还未经落盘的“可靠完成”或重新执行。磁盘完全不可写时不能虚称失败状态已持久化，日志要如实说明。
- shutdown 先停止新受理，处理队列，再有界等待完成落盘。deadline 后保留可恢复 unknown，不把子进程终止等同“没有执行”。测试使用屏障证明落盘先于 clean exit；硬崩溃重启只恢复证据，不重派不确定任务。
- 保留原文件权限、原子替换与清理本次临时文件的安全做法。承诺范围是受控进程故障与重复执行防护，不宣称任意硬盘损坏下都 exactly-once。

## 3. Client：把提交与观察分成两种操作

保持调用方熟悉的 `runTaskDetailed()`，内部增加明确的 `prepare/submit/observe` 边界；恢复 API 接收已保存快照，不能重新构造任务。

1. `prepare` 冻结实际 envelope、原路由/身份、digest，await checkpoint 保存成功后才有任何 POST。保存失败则网络调用数=0。
2. 仅在能证明未送达的初次连接失败，或收到有绑定的 not_accepted 时，按现有有界策略重试。400 是 rejected；409 必须区分已确证未执行的 session_unknown 与 binding_conflict，不靠消息字符串区分。
3. POST 可能已送达但回包丢失/超时/损坏，转为观察原任务。收到 202 后同样只观察。不要让观察抛出的 ENOENT 被外层提交循环当成可重试 POST。
4. 观察超时是本次等待期限结束；原任务不因此失败或取消。保留 pendingOperation 供 UI/重启恢复。短轮询使用有界超时和退避，不降低模型执行时限，不无限忙轮询。
5. 取回结果必须核 requestId/digest/kind/storeId/原 Provider/model/合同及 session key。任何合法格式但不属于原任务的结果按 conflict，不先消费 output 再报错。
6. completed success 与 POST replay 使用统一解析路径并保留 outcome.sessionHandle、trace。completed failure 以权威终态直接构建 completed_failure，内部 HTTP status 仅作原因。
7. fallback 先看结构化 stage：uncertain/rejected/conflict 无条件禁止；not_accepted 与 completed_failure 才按现有明确类别判断。把新 stage 贯穿 trace parser、error chain、UI，而非依赖中英文正则来做安全决定。
8. completed output 的本地解析若不通过当前合同，保留原记录，报内容/合同错误；不能因解析异常重新调用原物理任务。

## 4. 恢复贯穿真实 role/checkpoint/fallback

沿现有 `RoleAgentLoopOptions` 的 produce/audit 操作上下文增加提交生命周期接线，不写新的 role runner：

- client 的 `beforeSubmit(preparedOperation)` 必须在网络前调用；role 用已有 checkpoint.save 将快照存到当前 phase。这个 hook 必须同时传过 FallbackCodexTaskClient，保存的是选定候选的实际物理 ID、Provider 与输入 session，不是候选列表的抽象 ID。
- role 提供原任务恢复回调/能力。恢复时在调用 producer/auditor 的网络路径前检查 pendingOperation，直接通过原 client 的 observePrepared 取回结果，再进入原 validate/checkpoint 流程。不要再次调用 producer 生成一个新 payload 来恢复。
- producer 与 audit 适配器的 callback context 传递 hook；覆盖 treatment、script、director、role-audit，以及采用相同 loop 的 topic/其他现有调用者。保持具体 prompt 和质量迭代逻辑，不按节点复制一套恢复代码。
- `FallbackCodexTaskClient` 必须转发 requestOptions（含 timeout 与持久化 hook）。恢复选择原持久化路由；内存 sessionAffinity 只能作为缓存，不是权威。原 provider 暂时不健康时仍先核原请求，不能过滤掉它后直接选备选。
- 只有前物理任务被证明安全终结且类别允许，才能登记下一次候选尝试；不能重用属于其他 Provider 的 sessionHandle。相同 session 的连续修订必须保住其原 Provider。
- 恢复查询不增加 generation、phaseAttempts、sessionRebuilds 或语义 audit iteration。新的实际模型调用才影响相应计数；质量审计轮次与网络尝试仍分开。
- 已完成结果原子写入 checkpoint 后才清 pending；若崩溃发生在两者之间，重读应幂等，不重做已 passed 阶段。generation、失败尝试和选中路由也要随 checkpoint 一起保存。
- 保存旧版本读取能力：旧 completed + 可核验历史绑定可恢复；旧 accepted 或残缺记录不能用当前 prompt/当前目录猜出“原绑定”然后重派。不删除用户旧 checkpoint，不批量迁移历史数据，不重新启用 legacy 新生产。

若现有 adapter 的结构要求小幅调整回调签名，可以调整；在 RESULT 说明。验收要求是真实生产调用链经过这里，而不是新方法只有测试会调用。

## 5. Studio 的最小用户恢复闭环

沿现有 service/API/shared DTO 增加 `taskRecovery` 投影，不新增顶层 run 状态机。建议字段：taskState、observationError、nodeId、原任务简短诊断、resultAvailable、allowedActions。

只暴露用户需要的信息，不把 prompt/envelope、内部 session、原始路径或密钥输出给浏览器。后端从可信 run/checkpoint 取绑定；客户端不得传入另一个 socket、任意 requestId 或自行声明 not_accepted。

新增/扩展现有节点动作，语义固定为：

- **查询原任务**：只向原 Broker 查询，记录观察和可用结果，不调用模型，不解暂停、不创建 scope、不推进付费步骤。
- **取回结果并继续**：原 binding、版本和执行 lease/CAS 核验后，让既有 worker 消费原 output 并继续未完成节点；不能从页面直跳到任意后续节点。暂停时只能保存结果，继续须走既有显式恢复动作。
- **重试失败步骤**：只在服务端已证明可安全新尝试时给出；rejected/conflict 先修合同或配置，unknown 不显示普通重试。现有 retry API 同样检查，不能只隐藏按钮。

动作名称和路径沿仓库惯例；后端返回 allowedActions，客户端按它渲染，服务端执行时再次检查。多次点击/多个请求恢复只能有一个消费者；复用现有 run 锁、lease/CAS，不做第二套协调器。

所有入口通过同一恢复服务。编辑产生新计划版本后，旧结果可留为历史证据，但不得附到新 snapshot。暂不继续、暂停、调整方案的原语义保留。

示例用户文案：

- 正在处理：“模型正在处理，已保留当前进度。可以稍后查询原任务。”
- 结果未知：“暂时无法确认这次任务的结果。我们没有重新提交；请先查询原任务。”
- 结果已取回：“已取回之前的结果，无需重新生成。”
- 合同错误：“本次请求未被接受，已有成果已保留。需要修正服务配置或请求内容。”

文本恢复不要求用户核现金账单；媒体账本未知仍保留现有安全核验，不能混为一谈。页面需 1440/390 宽度可用，按钮 loading、防重复点击、错误提示和焦点可理解，不重设计整个工作台。

## 6. 输入合同：完整偏好，不引入部署耦合

### 当前输入修正

- topic 保持唯一字段 `strategy`，不恢复 creatorStrategy 双字段；generationNonce 只影响生成身份，不进入模型 payload。
- `formatTopicStrategy` 保留所有当前合法配置。固定顺序拼接定位、受众、优先、避开、来源说明、补充原则，上限 **6000 字符**；删除 head.shift/静默 slice。
- 字段自身仍按现有 500/500/1000/1000/2000 校验；组合超限要显式错误，不能默默删语义。测试必须用全部字段的最大合法长度和中文/换行，验证完整内容及 sourcePolicy 都到达模型。
- Broker 的 topic 输入长度同步 6000；未知字段仍拒绝。原 `creativeTreatment/durationRange/planningIssues` 的验证和嵌套结构不能为了过测变成 any。

### 合同声明和守卫测试

本仓库 Broker 从镜像单独提取 `apps/codex-broker` 部署，现有 build rootDir 也是该应用 src。此轮**不把 Broker 运行时反向依赖 Studio/pipeline、不加共享 npm 包或代码生成平台**。

最小决定：在 Broker `task-definitions.ts`（必要时同目录小文件）声明被修改的 `topic-ideas` 和 `script-draft` 输入合同描述，包含版本、合法字段/变体、边界限制；broker parser 的限制从这些声明取。`taskContractDescriptorFor()` 摘要纳入 inputContract，不仅 prompt/output；相应 input 变更必须改变摘要。script-draft 同样加入 expected digest/capability 保护，既有受保护 kind 不削弱。

Studio builder 和 pipeline 维持各自无副作用构造边界，通过**跨包构建/测试守卫**核对输入限制、实际 payload、Broker parser、descriptor 与客户端 expected digest。这里是“同一合同的可验证两端实现”，不是冒称已经共享同一个运行函数。针对当前部署形态，少量声明镜像加严格测试比引入宿主依赖更小。

守卫必须由正式测试脚本运行，不能仅放 docs：

1. 实例化真实 `CodexTopicIdeaModel`、`CodexScreenwriterAgent` 等正式适配器，以受控 transport 捕获其实际 envelope，再交真实 Broker parser；不能自己手写一份 brief 证明自己。
2. 覆盖初始/repair-delta/repair-bootstrap/validation-repair 与 audit，包含真实联合规划上下文、时间范围、来源和同一 snapshot。
3. 输入边界与 inputContract 声明一致；未知字段、超限、input digest mismatch 在 executor 前拒绝。client 固定预期摘要需与 broker 重算值严格一致，不动态相信 health 返回的任意摘要。
4. 正式构建的 Broker 在仓库外临时 release 目录也能启动；无需加载整个 pipeline/SQLite/Studio，避免源码测试绿而独立部署坏。

### 最近一次选题结果

沿现有 trend generation 状态保存小型结构化 receipt：本轮 ID/时间、是否调用模型、实际 provider/model、结果或失败/回退原因。空 ideas 也有 receipt。API/UI 从它投影，不再从候选列表猜最近一轮结果。没有历史 receipt 就如实显示尚无记录，不回填虚构成功。

## 7. 完成和范围控制

具体证明见 ACCEPTANCE。确定性测试过后，用正式环境验证真实文本、合理小额媒体、成片、双审、返工。不要在服务缺配置时把 fake broker 接线进去冒充真实验证。

修复范围内的问题继续集中解决。若 E2E 暴露需要改变既定产品语义、破坏性迁移或新增系统的独立大问题，先记录事实和最小决定，不能用“必须全绿”为由无限扩项。其它已可覆盖路径继续测完。
