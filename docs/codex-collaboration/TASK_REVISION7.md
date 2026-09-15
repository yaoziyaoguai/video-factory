# 当前执行任务

- taskId: VF-R3-CLOSURE-20260912-01
- revision: 7
- status: CHANGES_REQUIRED
- 仓库：/Users/jinkun.wang/work_space/veidofactory
- 协作目录：/Users/jinkun.wang/work_space/veidofactory/docs/codex-collaboration
- 审查窗口维护 TASK/REVIEW；执行窗口修改产品/测试并追加 RESULT。一次集中完成本任务，不擅自进入新业务。

## 目标与顺序

revision 6 的重复审计修复已被独立复验接受，不再重做。新 QA 阻断及跨边界复查收敛为四项：health 清单、发布文案 digest、实际模型绑定、未接入的角色恢复。详细证据见 REVIEW_REVISION6.md。

一次按以下顺序推进，不每修一项等待审计：

1. 复现四项失败，确认当前基线；将下面的有限验证矩阵落实为正式失败测试。
2. 集中修复 R6-F01–F04；不得只补 health 五个字符串就转真实模型测试。
3. 聚焦矩阵与受影响集中回归通过，最终 production build 的组合检查通过。
4. 安全部署真实本地环境，按有界 QA 补完未覆盖的制作链。QA 期间先记录，不边测边改。
5. RESULT 追加 revision 7 + 新 QA 报告，设 READY_FOR_REVIEW 后停止，交审查窗口统一复核。

## 必读与基线

首先完整读取：

- 本 TASK。
- REVIEW_REVISION6.md（四项原因、实际影响、证据与边界）。
- RESULT.md 从“Revision 6 执行记录”到文件末尾。
- ACCEPTANCE.md 的 G01、G03、G05–G08、E01–E07。
- docs/qa/videofactory-real-local-qa-20260913-05.md。

再读取当前相关源码、package scripts 与证据脚本。旧 A/B/C 和 PROMPT_REVISION.md 仅在涉及某条既有不变量时按需查，不重新选型或重写全部提示词。

基线：evidence/r7-start-baseline.json；当前 git status/HEAD 现场核对。保留所有 A/B/C 与历史 revision dirty changes，不能 reset/stash/clean。旧行号只导航，必须看当前上下文。本轮预算是集中收口，不是再开展全项目重构。

原样运行并记录：
```sh
node --test --test-concurrency=1 --import tsx docs/codex-collaboration/evidence/r6-contract-boundary-review.mjs
```
当前为 15 项、5 pass / 10 fail，exit 1。10 个失败属于四个根因。脚本使用正式 Broker/客户端/适配器和隔离外部传输，绝不能接入真实 Studio 当作 QA 环境。若结果不同，先解释差异，不能直接改断言。

## R6-F01：真实 health 与正式消费者一致

允许主要修改：Broker health 生成及正式测试；Studio probe 的测试；确有必要的窄小校验/包测试入口。

- 从 BROKER_TASK_KINDS 与 executor.identity.taskKinds 交集生成全部 digest，复用 taskContractDescriptorFor。
- Studio 继续 fail-closed；不缩小正式支持能力逃避缺失，不用动态抄 Broker digest 代替 pipeline 的独立 pinned 版本。
- 全任务 OpenAI/ZAI、合法支持子集必须经真 socket 被正式 read*ProviderSettings 接受；缺失/错误任一受保护 digest 必须拒绝；health 不触发模型。
- 正式 release/build smoke 必须实际调用消费者，不能只看 HTTP200、taskKinds 数量或“配置齐全”。不要求执行云端部署来证明。

## R6-F02：静态任务合同与平台输入分离

允许主要修改：task-definitions.ts、两个 executor 的 descriptor 用法（如确有必要）、pipeline 的 publish-copy canonical pin、对应正式测试。

技术方案已定：

- contractDigest 是任务类型的静态规则摘要，不是某次输入渲染出来的 prompt 摘要。
- publish-copy digest 计算包含通用发布规则、完整 PLATFORM_NOTES、默认平台规则、schema/语义版本。用同一 canonical descriptor 服务 health、parser、两个 executor 与返回 trace。
- platform 仍进入实际 prompt 并由 requestDigest 区分；不能删平台风格、降低提示词质量，不能令 trace.digest 无条件等于客户端 expectedDigest。
- 其它任务仅核验，不无故改变其 digest；发生真实规则变化才更新对应 pin。
- 已存在 durable/checkpoint 不迁移、不重写。旧完成结果若合同不能证明符合当前标准，沿用既有安全恢复/重审，不能改写成新合同成功。

正式测试：

- 五个现有平台 + 未知平台，合法输入经正式 client/parser/两个实际 executor/结果处理。外部 HTTP/子进程允许用隔离替身，不手写替代 Broker/parser。
- 初次生成、修订、正常完成和原结果重放；每次原请求只执行一次。
- canonical digest 不随 platform 选择变化；修改某个平台规则会改变 canonical digest；不同平台 payload 产生不同 requestDigest。
- 非法/错误 digest 在执行前拒绝，合法输出不再 422。

## R6-F03：受理前确定实际模型，结果必须匹配

允许主要修改：codex-executor.ts 的 identity 类型/解析、zai-code-plan-executor.ts、Broker task-binding/server、pipeline codex-task-binding/chat、必要的 Studio probe 类型/校验，以及对应测试。保留独立 Broker 的部署包边界，不新增跨 app 运行时依赖。

采用最小声明式扩展，不另造路由平台：

- 在现有 identity/health 增加可选 taskModelRoutes。仅对现有“同 kind、有图/无图不同模型”的 asset-rank 与 role-audit 声明：
  `{ withoutImages: <已配置文本模型>, withImages: <已配置视觉模型> }`。
- 普通固定模型任务沿用 taskModels/modelId；taskModelRoutes 不替代已有 taskKinds/合同清单。字段名可按项目类型命名风格微调，但语义不得另选方案。
- Broker 根据已验证 payload 的 thumbnails（asset-rank）或 images（role-audit）是否非空，确定具体 modelId；executor 使用同一选择规则。
- 客户端 prepare/readBrokerBinding 使用同份路由声明与真实 payload 选择，并把实际 modelId 写入现有 brokerBinding/task binding。不要根据是否拿到模型回复再反推绑定。
- 路由配置及模型名称由配置派生，不写 glm 字符串、题材、镜头或 runId 特判。保留当前无图用文本强模型、有图用已配置视觉模型；不统一降成 Flash。
- 静态 taskModels 是默认能力描述，混合路由的实际调用身份以已解析 binding 与 trace 为准。Studio 不得把未知/畸形路由宣告 ready。
- 成功输出的 trace.kind/providerId/modelId/contractDigest 必须匹配原 binding；Broker 完成边界与客户端消费边界都验证。失配不是可重试网络故障，不自动换 ID/backup，也不能回写或伪造 trace 使它通过。
- observePrepared / 查询 / 重启恢复沿用原快照的模型和路由；不因当前默认模型或路由配置变化重绑旧任务。历史不一致证据如实停住，不能“修账本”。

正式测试至少覆盖：

1. role-audit 有图/无图、asset-rank 有缩略图/无缩略图、正常 visual-review/reference-grammar、普通文字任务。
2. OpenAI 固定模型对照；ZAI 默认配置与自定义文本/视觉模型名。
3. 正确外层 binding 但 trace 的 model/provider/kind/digest 错误或缺失；拒收、无新调用。
4. 完成查询、重放、客户端/Broker 安全重建，身份与原结果不变。
5. 两个审片 producer 仍不同实际模型、同证据；内部“报告质量审计”和作品双审不能混为一谈。

此扩展只填补当前已存在的混合模型身份表达，不增加任意动态路由、模型发现服务或新任务种类。

## R6-F04：把既有恢复协议接到遗漏的正式角色

允许修改：

- packages/production-pipeline/src/asset-semantic-ranker.ts
- packages/production-pipeline/src/codex-visual-review.ts
- packages/production-pipeline/src/reference-grammar.ts
- apps/studio/src/server/series-planning-agent.ts
- 必要的相关 client 类型、正式组合调用点与对应测试。

实现路径：

- 参照现有已通过的 treatment/script/director/publish/topic 接线，不重写 role-agent-loop。
- produce/audit 都传递 operation.requestOptions（尤其 beforeSubmit）。
- preparedOperation 存在时只走原对应客户端 observePrepared，不重新生成 payload、下载新的证据、切当前默认 Provider 或再 POST。
- 视觉审片 producer/audit 的客户端分工、审计 stateless 模式、既有会话、deadline 与独立性保持；恢复只观察已提交工作，不新加 session。
- 参考片/选片的重新采样或下载不能覆盖已保存原请求；确需后续新操作时再按当前输入形成新请求。
- client 接口必须表达真实恢复能力，不用 any/强制断言掩盖缺失方法，不制造生产 fake 分支。

验证要从正式适配器进入，覆盖四模块的 produce/audit，系列包含 generate 和 reviewEpisode：

- beforeSubmit 保存成功早于 POST；保存失败 POST=0。
- 已受理、丢回包/超过本次等待窗时 checkpoint 保留原 envelope/binding/socket/requestId。
- 迟到成功/失败后重建客户端/适配器，先观察原任务；producer 和已完成前序不重跑。
- 同合同成功复用、合同升级的旧审计不能认证新标准；精确人工许可不泄漏到新失败。
- 视觉补审和恢复的 media/voice/render 调用增量=0；不得因为没有快照就重新采购。
- 不以裸 role-loop 单测或 source.includes 字符串断言代替正式适配器行为测试。

## 一次性合同矩阵与集中回归

新增测试纳入正式 package scripts。用一张有限矩阵记录现有十个任务的以下证据，不扩展到项目没有的模型/任务：

- task kind / 当前 producer 适配器 / canonical descriptor / health / 实际模型规则 / produce-audit 恢复接线 / 正式测试文件。
- 对未修改且此前已通过的路径引用已有测试；对上述缺失项补真实 producer-consumer 组合测试。
- 不要求把所有错误与所有角色做无意义笛卡尔积；错误矩阵共享边界可复用，四个漏接适配器必须各有真实接线行为证据。

本轮验收 ID：

| ID | 放行证据 | 原合同关联 |
| --- | --- | --- |
| V7-01 | 全任务及子集 health 真消费者成功，缺错合同拒绝 | G01/G08 |
| V7-02 | 平台 digest 一致且规则变更受保护，两 executor 正常完成 | G01/A11 |
| V7-03 | mixed-model 绑定与实际 trace 一致，错身份拒收 | A03/A11/G03/G06 |
| V7-04 | 四模块正式恢复接线及单分支补审安全 | G03/G05/G06 |
| V7-05 | 原恢复边界39项、新四类矩阵、现有回归保持通过 | G02–G07 |
| V7-06 | 最终 dist + 正式消费者组合通过，真实本地角色可用 | G08 |
| V7-07 | E01–E07 真本地补测及每项准确证据/阻断原因 | E01–E07 |

集中运行并逐项记录终态与退出码：

```sh
node --test --test-concurrency=1 --import tsx docs/codex-collaboration/evidence/r4-boundary-probes.mjs docs/codex-collaboration/evidence/r4-receipt-race.mjs docs/codex-collaboration/evidence/r5-combined-audit.mjs packages/production-pipeline/test/role-agent-loop.test.ts apps/studio/test/text-task-production-recovery.test.ts apps/studio/test/text-task-recovery-receipt.cross.test.ts
npm run test:ts
npm run test:broker
npm run studio:test
npm run typecheck
npm run build
node --test --test-concurrency=1 --import tsx docs/codex-collaboration/evidence/r6-contract-boundary-review.mjs
VF_REVIEW_DIST=1 node --test --test-concurrency=1 --import tsx docs/codex-collaboration/evidence/r6-contract-boundary-review.mjs
npm run test:package
git diff --check
```

新增正式测试也运行；新协议若需调整证据脚本，保留其行为断言，记录准确原因，不能删失败场景。npm run build 已包含 build:pipeline，无需重复再构建一次。保持同一 Node/ABI，禁止靠清数据库解决测试环境问题。Python/媒体文件未改可引用既有131/131并注明；若实际改变则重跑原 unittest。不把超时、截断、取消当通过。

## 最终 build → 真实本地 QA

确定性门全过才继续；无需再等一个中间审计回合。

1. 现场核对真实 PID、工作目录、启动文件、dist、两个 socket 和在途任务；不能照抄历史 PID。只在无在途任务或已证明可安全恢复时正常重启，保留 durable/checkpoint/workspace/登录。
2. 按现有正式凭据加载启动 OpenAI/ZAI Broker 与 production Studio。沿用真实配置，不打印/复制密钥；明确传入两个 socket，避免本轮漏参再次发生。将最终非敏感启动说明写入 QA 报告，方便下一轮复用。
3. 浏览器前先验证两 socket 的正式 consumer readiness 和 /api/providers 关键角色可用、Python/FFmpeg 可用、实际配置模型/强度。health200不是 ready 的替代证据；这一步不提交模型。
4. 完整读取当前 QA/report-only 与浏览器技能，用真服务、真模型开展测试。不得挂 fake Broker、修改数据库解锁或手工标审片通过。

有界覆盖路线（详见 ACCEPTANCE E01–E07）：

- 三入口各一条到方案/报价；优先自有想法先打通共享后段，系列与合格来源热点随后验证前门。来源不足是有效阻断，另选合格样本，不放宽规则或反复刷新同题。
- 分配这几条 run 覆盖方案修改、报价三动作、暂停与显式恢复。未同意时媒体 create=0，未知时不再确认第二笔。
- 一条代表性新片完成真实媒体、TTS、渲染；其它入口原则上停报价。完成平台文案草稿也要验证，但绝不外部发布。
- 两个真实不同审片 producer、同 evidence SHA、独立结果。失败如实记录；质量没过不能盖章。
- 必要局部返工核对建议预填、影响范围、不变素材 SHA/复用和费用增量；首片通过时只测打回草稿/取消，不制造缺陷烧钱凑覆盖。
- 1440/390 重点测真实 run 的等待/恢复/报价/审片。第五轮已通过且本轮未改的模板/搜索等只简短冒烟，不重做整套截图；新 run 刷新/安全重启持久化要补。
- 逐段看新片、核对真实帧数/时长/声画/一致性/文字干扰/开头承诺与结尾兑现。历史片不能替代。无法直接听声时可用可用的音频读取/转写能力辅助，仍要区分文本与真实音质/同步证据，不能假称已听见。

费用与停止：

- 用户授权合理小样本真实 QA，可自行确认精确报价；本轮新增媒体+TTS 合计先按 ¥50 止损（测试资源线，不是产品费用硬限制）。
- 每笔先记录报价、范围、已有消费、Provider/媒体结果，优先复用。超过止损需报告所需金额和覆盖目的；不缩减质量、不擅自几百元花费。
- 文本/订阅审片不额外现金审批，TTS 自动但后台继续人民币记账。
- 同根因同路径失败，只有新证据或前置条件明确改变才恢复一次；再次同因失败停该链，继续独立项。不能不断建 run/重试/刷新报价碰运气。
- accepted_unknown 只观察原任务；不知道是否完成不换 ID/backup。等待本身不是反复执行。
- 记录排队、produce、audit、Provider、传输/观察、校验、重试、总耗时及调用次数；没有数据写未知，不一概怪网络，不调低质量/模型/强度或缩短超时制造提速。
- QA 发现问题先记现象+原始错误+已证实原因/推测+已排除项+复现+费用+影响链路；不要只记失败不查原因。QA 阶段不边改边重启，整轮结束统一交回。

## 权限、Non-goals 与交付

- 只修上述四项及不可分割的测试/接线；不重新实施 A/B/C，不拆巨型文件做清理，不新增框架/数据库/缓存/任务中心，不重写全部 prompt。
- 不降低选题/事实/视觉质量门槛，不添加题材/镜头/runId/特定模型名补丁，不保留第二套旧生产路径。
- 原时间轴、产物绑定、媒体复用、lease/CAS、精确授权、双审独立性必须保留；失败不得说明卡伪成功。
- 不新增“单视频×单角色终身三次机会”产品限制，不取消既有有界重试。
- 不 commit/push/云端部署/外部发布，不删除迁移用户数据或改旧 durable 证据，不读取无关私人数据。
- 不启动会重叠修改同一文件的并行执行者，不擅自降低当前用户配置模型或思考强度；如运行环境替换/忽略配置，报告真实情况。
- 审计探针与测试替身只在隔离测试进程里运行，禁止挂进真实 QA 环境。

完成后 RESULT 追加 revision 7：相对新基线的实际文件变化、四项原因及实现、V7/E ID映射、命令退出码、真实启动说明、QA报告、每笔费用、未验证/风险。保留已有记录，不改 TASK/REVIEW。新的真实 QA 报告使用唯一文件名，不覆盖第五轮。

**集中修复与验证、再一次有界 QA 完成后停止；未测到的链路写 BLOCKED/NOT_VERIFIED，不能宣布整个项目已全部验收。**
