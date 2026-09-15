# revision 3 实现复审（2026-09-13）

裁定：**CHANGES_REQUIRED**。对应 TASK revision 4，执行端在 RESULT 追加 revision 4，不能改写旧报告。

## 结论

本轮不是重审 A/B/C，也不重开提示词改造。已完成修复应保留：底层任务受理与查询合同、独立运行中的恢复按钮、人物关键词退出生产校验、能力摘要与 referenceGrammar 接线、同角色生成/审计上下文对齐均有源码与聚焦测试支持。

本窗口独立验证：39 项原探针/跨进程/合同测试、255 项服务/规划/角色测试、65 项 UI 测试，合计 **359 pass、0 fail**，三个命令均 exit 0。四个项目的无输出类型检查 exit 0，git diff --check exit 0。这不是全仓全量或真实 E2E 通过声明。

额外六个探针中：**两个对照通过，四个合同断言失败，exit 1**。下文是本轮唯一新增产品修正范围。报告所写 R01、R04、PR10 的 PASS 范围需要收窄，不据此否定其它有效修复。

## F01 / P1：合同升级丢开尚未结清的原任务

位置：packages/production-pipeline/src/role-agent-loop.ts:514–542；production-pipeline.ts:10127–10147 的 checkpoint 选择；各角色 CONTRACT_VERSION/criteria 与调用接线。

证据：同一 accepted input / 同一 checkpoint，首次 produce 保存 pendingOperation 后结果未知。原合同恢复时 produce 新提交 1 次、observe 原请求 1 次（对照通过）；只改变 contractVersion 后，produce 新提交累计 2 次且两个 requestId 不同，observe=0。restoreCheckpoint 在 contractDigest 不匹配时直接 fresh，丢弃未结清的 pending。本轮恰好升级了核心角色合同及 criteria，pipeline checkpoint key 还包含 contractVersion，因此真实集成还必须覆盖“文件位置变了，旧 pending 不再被 load”的分支。

这是原任务恢复与当前创作合同之间的边界遗漏。Broker 原请求本身仍可查询，并不能证明角色/工作流会选中它。已复现的是正式 role-loop 控制流的新请求路径；未制造真实模型重复执行或媒体扣费。

违反：PR10、G03、R01 的“已受理/可能受理不换 ID；旧 pending 按原绑定查询，不按新 prompt 重建”。正常已完成旧成果因新合同需要重新校验，与结果未知的旧任务是两种情况，不能混为一谈。

最小修正：
- 先判是否存在未结清的物理任务，再判当前创作合同是否可复用。对旧 pending 保留原 envelope、route、binding，按既有 owner/run/checkpoint 证据查询；不能因合同/criteria/能力摘要/pin 更新直接 fresh 或选新文件然后发起新调用。
- 可以安全取回旧原始结果，但不得假称它已满足新合同。不能安全接续时明确停住并保留可操作原因；禁止删除 checkpoint、“已完成”伪造或自动换模型解除阻断。
- 覆盖 role-loop 层以及真实 joint-v1 pipeline/角色 adapter 的升级恢复。不是只在 CodexBridgeClient.observePrepared 的单元测试中传入旧 operation。
- 保留正常、已结清任务在用户明确调整方案后的重新规划能力，不引入全局终身次数限制。

验收：同合同恢复对照保持通过；合同/criteria 改变且旧 pending running/unknown/completed 三类都不产生未经结清的新物理请求。证明不同 checkpoint 文件名、fallback 候选改变、工作流恢复后的旧请求仍可定位；旧成果必须经过适用质量校验才进入新计划。

## F03 / P1：迟到的已失败结果进入“只能查询”的死路

位置：apps/studio/src/server/production-studio.ts:1976–1987、:2017–2055、:2389–2406；RunWorkbench.tsx:397–398；role-agent-loop.ts:740 的已有 completed_failure 消费分支。

证据：正式 joint-v1 run 的 worker 已返回失败，pending 尚未清理；之后单次查询收到可信 completed_failure。服务返回 allowedActions=[query_original_task]，说明文字却让用户“重试或选择其他模型”。实际 retryFailedNode 与 retrieveOriginalTextTask 都返回“请先查询原任务”；再次查询不会改变结果。UI 同时隐藏普通重试和调整方案入口。本探针 GET-only、POST=0，不是模型仍执行时强行重试。

违反：R01 的失败矩阵、G03/G05/G08 的可行动恢复；安全停止不能退化成确认终态后永久无法操作。

最小修正：
- 让可信的 completed_failure 经现有 lease/CAS 与 role-loop 终态处理结清原请求，保留已通过候选/上游成果，再根据真实失败分类开放现有的人工重试或调整入口。
- 沿用已有角色 completed_failure 处理和 generation 递增规则，不另建状态机。不要仅把 UI 按钮放出来却仍被 API 拒绝，也不要绕过原任务绑定核验直接创建新请求。
- terminal failure 与查询失败分开记录。校验/合同错误不能伪装成临时基础设施失败并自动 backup；未知/冲突仍不可自动重派。
- 用户暂停不解除，两个恢复请求不能推进两次；媒体授权边界不变。

验收：joint-v1 节点含 produce/audit 两个 phase；late completed_failure 后有实际可成功的恢复路径，查询本身 POST=0；人工动作经正式 pipeline 验证原候选保留、旧 ID 不重用、新请求仅在允许的失败分类与动作下创建。补并发和暂停对照。修改后探针可改为断言这一真实恢复行为，而不是仅多了一个 action 字符串。

## F02 / P2：同义改写仍绕过第二次无进展止损

位置：packages/production-pipeline/src/creative-planning.ts:453–469、:482–511、:942–970。

证据：正式规划图 + 临时 SQLite、候选 ID/数量/分数不变（目标镜头始终 20 分），只改 query 时第二次 needs_source，director/rank 各 2 次；再把 successCriteria 的同义表达改成“完整展示旋转动作 / 旋转动作完整可见 / 应看到完整的旋转过程”，则 director/rank 各 3 次，最终为 cross_role_revisions_exhausted。原有跨角色上限仍有效，**不是无限循环**，但本轮承诺的第二次止损没有覆盖正常模型改写，会额外浪费一轮长调用。

根因：identityDigest 直接包含可被导演逐轮重写的 narrativeTarget（successCriteria、visibleAction 等）和 scenePositions。换成结构化字段并没有让目标身份稳定。

违反：R04/R3-07“同目标换措辞无改善停止；不同真实目标/证据改善继续”。

最小修正：
- 在现有已接受脚本/构思及 issue/checkpoint 中保留该目标的稳定来源关联，并跨导演重试携带；不要每次从新候选的自然语言重新发明目标身份。
- 原始文字用于审计依据，不等于 identity。真正的目标/范围变化由已有上游修改身份与关联表示；不是任意一次导演改措辞就获得新额度。
- 比较已有候选证据的实际改善，保留不同目标和真实改善的放行反例。
- 不加否定词/同义词白名单、题材特判、新 LLM 判断层、向量库或“收敛平台”。

验收：同义改 successCriteria/visibleAction、仅改 query/artifact 不多跑无效轮次；不同实际目标与相同目标确有候选改善分开测试（不要只用“目标和分数同时改变”的一个用例替代二者）；重启后累计证据不丢失。

## F04 / P2：查询失败把旧状态时间刷新为现在，UI 未显示可信时间

位置：apps/studio/src/server/production-studio.ts:1972–1987、:2399–2409、:2509–2525；apps/studio/src/shared/api.ts:719；RunWorkbench.tsx:79–82。

证据：先成功查询 running，后查询返回 503。taskState 被正确保留，但 receipt.observedAt 被重写为第二次查询时间；DTO 没有旧可信事实的时间，summary 仍写“原模型任务仍在处理中”。虽然提示本次查询未取到状态，但用户不能知道“仍运行”是何时确认的。额外探针用真实 ProductionStudio 方法和正式绑定响应复现。

违反：R01 明确要求“最近已核验事实与本次查询故障/观察时间分开；不能把历史 running 冒充实时证明”。

最小修正：
- 复用 receipt，区分 last verified fact/time 与本次 attempt/error/time（字段名自行按现有风格确定）。query failure 不能覆盖可信时间；没有可信事实时明确 unknown。
- DTO/UI 显示“上次确认仍在处理（时间），本次未取得新状态”，而不是持续刷新假实时状态。
- 不新建观测平台。terminal failure 的错误也不应写进“查询故障”字段。
- 同一任务并发查询的迟到响应不能把已确认终态回退为旧 running；该项为相邻状态更新边界的回归要求，不冒称本轮已复现。

验收：成功 running→query_failure、completed→query_failure、首次即query_failure、旧响应晚到、刷新/重建；时钟与状态断言、API 和 UI 同口径，query 不改变轮数或新增 POST。

## 验证记录与资料边界

当前 HEAD 570fe6e59e072c4965c86769bf2096825f003383，分支 codex/final-dual-review-cloud-acceptance。原 BASELINE.json 的 314 文件当前有 58 个哈希变化、0 缺失（执行前报告为 46）。没有找到单独持久化的 revision 3 起始文件级快照，故不能仅凭这些数字给各轮精确归属。新记录 evidence/r4-start-baseline.json 供下一轮比较，不覆盖旧基线。大量 A/B/C dirty changes 不归本轮。

独立运行命令（仓库根，UI 命令例外）：

```sh
node --test --import tsx docs/codex-collaboration/evidence/r3-review-probes.mjs docs/codex-collaboration/evidence/transport-audit.test.mjs apps/codex-broker/test/task-lifecycle-v3.cross.test.ts apps/codex-broker/test/durable-owner-lifecycle.cross.test.ts apps/codex-broker/test/topic-script-contract.cross.test.ts
# 39/39，exit 0

node --test --import tsx apps/studio/test/studio-service.test.ts packages/production-pipeline/test/creative-planning.test.ts packages/production-pipeline/test/codex-screenwriter.test.ts packages/production-pipeline/test/codex-visual-director.test.ts packages/production-pipeline/test/codex-creative-treatment.test.ts apps/codex-broker/test/task-definitions.test.ts
# 255/255，exit 0

# apps/studio 下：
../../node_modules/.bin/vitest run test/task-recovery-ui.test.tsx test/node-workspace.test.tsx test/run-observability.test.tsx
# 65/65，exit 0

# 仓库根，四条逐一执行，均 exit 0：
./node_modules/.bin/tsc -p packages/production-pipeline/tsconfig.json --noEmit
./node_modules/.bin/tsc -p apps/codex-broker/tsconfig.json --noEmit
./node_modules/.bin/tsc -p apps/studio/tsconfig.server.json --noEmit
./node_modules/.bin/tsc -p apps/studio/tsconfig.client.json --noEmit
git diff --check
```

新增探针在 evidence/r3-post-review-extra.mjs、r3-post-review-service-extra.mjs；运行 `node --test --import tsx docs/codex-collaboration/evidence/r3-post-review-extra.mjs docs/codex-collaboration/evidence/r3-post-review-service-extra.mjs`。日志 r3-post-review-red.txt：2 pass / 4 fail，exit 1。正式绿灯日志 r3-independent-core-green.txt、r3-independent-service-role-green.txt、r3-independent-ui-green.txt。

首次测试因沙箱禁止监听 socket 而 EPERM，取得隔离测试权限后上面三组正式验证成功，EPERM 不算产品缺陷。新增探针初稿缺少 brief 版本/开关、joint-v1 字面值，以及错把外层异常当底层原文；均为本窗口夹具错误，最终已更正后确认四个真正合同失败。不要把这些中间错误交给产品实现修。

角色 pending 探针替身只证明正式 role-loop 控制流，规划探针用正式 graph/store，service 探针为真实 ProductionStudio + 隔离 HTTP 响应 + joint-v1 run；没有将替身接入正式 QA。执行端须补正式 pipeline 级失败/恢复测试，不能把这些窄探针冒称完整生产集成覆盖。

本窗口未修改产品、未启动真实模型/媒体、未重启正式服务、未 commit/push/deploy，未外发源码给 Oracle。Graphify 仅现有图查询，未更新。没有独立重跑全仓全量/Python、浏览器真实点击或真实成片；执行端已有全量通过报告属于其证据。

## 执行纪律：按完整行为闭环验收

前两轮漏项的原因是证据粒度偏窄：client 能查结果、FakePipeline 收到 dispatch、UI 有按钮，不等于真实制作流程能消费正确结果。四个发现不能只作为四个局部补丁。

本轮按两组完成：

1. 原任务生命周期（F01/F03/F04）：原请求事实不能被新创作合同抹掉；查询不推进；API/UI 允许的动作与实际工作流消费规则一致。
2. 规划止损（F02）：已接受的目标与导演本轮的描述分开；改措辞不重置目标证据，真实目标改变或证据改善才允许继续。

这只保护现有边界，不新增框架、任务中心、状态机或全局身份平台。先复用现有 checkpoint/operation/plan/lease；必要时才抽已有多个调用者共用的最小判断函数。

实现前在 RESULT revision 4 简短写明两组根因所在正式函数、最小修改方案、下列七组测试映射，然后连续实现。缺测试先补，不逐条等待审计，不重新研究 A/B/C。

| 必须验证的场景 | 行为证据 |
| --- | --- |
| 正常运行查询 | 一次查询；UI/API 都可用；任务、质量轮数不增加；不误报断连。 |
| 查询失败与迟到响应 | 可信时间不刷新；没有事实保持 unknown；旧 running 回包不能覆盖已确认终态；重建后仍一致。 |
| 未结清任务遇到新合同 | 旧 request/envelope/route/binding 保留；不同 checkpoint key/criteria/版本不导致新提交；原结果不冒充新合同验收。 |
| 迟到成功取回 | 正式 Studio → ProductionPipeline → 角色 adapter → Broker/client/checkpoint 接通；只消费一次，上游不重跑；并发/进程重建不能仅靠内存 Map 防重。 |
| 迟到失败恢复 | 先核验终态再执行分类相符的人工动作；按钮能实际完成后端行为；旧 ID 不重跑；unknown/conflict 不能因此自动 backup。 |
| 暂停/编辑 | 暂停不被查询解除；编辑后旧结果不污染新方案；同计划恢复不假装新创作。 |
| 目标与证据变化 | 同义描述、query/artifact/展示序号变化不重置机会；同目标证据改善、不同真实目标分别测试；重启保留累计证据。 |

优先复用已有跨进程/production-pipeline 恢复测试。替身只能放在外部模型/媒体边界，不能替换本次要验证的业务层；FakePipeline 被调用不能算取回成功。用 barrier 控制时序，断言物理提交、结果消费、上游执行、轮数和最终状态。正式环境不接 fake Broker。

新增探针不是全部验收：F01 不得通过永久禁用恢复来变绿；F03 不能只添加 action 字符串；F02 不加同义词或题材字典；F04 可调整字段名但须保留时间与状态行为断言。

两组完成后集中回归、集中修复、统一审查。RESULT 对七行逐项提供正式 test 名称、结果与证据；分别写已修复、静态风险和未验证，不能只报测试总数。

确定性检查通过后仍需完整真实本地视频 QA；浏览旧失败 run 不等于完成。真实模型/媒体需当前有效授权；缺权限时给最小范围和预估申请。至少一条新制作覆盖规划、报价、媒体、声音、渲染、两个真实模型独立审片及必要返工，其余入口尽量停报价。单条成功不能证明普遍提速或必出爆款。保留 E01–E07 的真实未验证状态。

## 下一轮执行与完成条件

1. 按 F01/F03/F02/F04 一次集中修完，先建立失败证据，修复后集中回归；不是四个等待审计的小关卡。
2. 产品实现沿现有模块；不重写十类提示词、不新加 AGENTS.md、不改模型或思考强度、不新建框架/数据库/缓存、不修 Graphify、不重做 A/B/C。保留旧修改。
3. 运行上述聚焦检查、相关正式 pipeline/跨进程恢复、支付/复用/暂停/双审回归，集中完成原 G07 全量；如实记录命令退出码和未验证项。不得只让新增探针变绿。
4. RESULT 追加 revision 4，修正本轮已被证据缩窄的 PASS 声明，不改写历史报告。
5. 完成后 READY_FOR_REVIEW；不自动提交/推送/云端部署或花钱。真实模型/媒体 QA 沿 TASK 现有权限边界，先确认当时有效授权；费用权限不足如实列未验证。
6. 真实成片、两模型审片、必要局部返工与新提示词的实际耗时仍未验收。这四项修完后才具备进一步完整真实 QA 的基础，不能宣布项目全部完成。
