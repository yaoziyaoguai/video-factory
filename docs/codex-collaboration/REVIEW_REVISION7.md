# revision 7：为什么仍未收口，以及下一轮到底修什么

结论：**CHANGES_REQUIRED，不能作为生产验收通过。** revision 7 指定的四类修复已有独立通过证据，应保留；这不是七轮工作全部无效。但真实报价、媒体、双审与返工仍未完成验证，也不能以回归测试数量代替可用性。

## 1. 本窗口实际核验

- 实际仓库 `/Users/jinkun.wang/work_space/veidofactory`；HEAD `570fe6e59e072c4965c86769bf2096825f003383`，分支 `codex/final-dual-review-cloud-acceptance`。
- 按 r7-start-baseline 的 324 个路径核对，23 个文件变化，与 RESULT 相符。HEAD 的整个 dirty diff 包含更早 A/B/C，不能全算成本轮新增。r8-start-baseline 记录当前 SHA。
- 阅读 RESULT revision 7、真实 QA 第六轮、当前 TASK/验收要求、相关实现与测试、两条本次失败 run 的原始输入和角色 checkpoint。历史 JOURNAL 只作历史背景，当前追加记录以 RESULT 为准。
- 独立运行：上轮边界 source 15/15、正式 dist 15/15；四个角色适配器 52/52；原恢复安全边界 39/39；Broker/路由/合同/client/Studio probe 聚焦 117/117。均 exit 0。未独立重跑全仓构建、Python、整套浏览器或真实模型。
- 新审查探针 source 与 dist 均 **6 tests，3 pass / 3 fail，exit 1**。其中两条失败是同一个画幅边界问题的不同层级复现；另一条是系列空事实合同问题。
- 没有改产品源码、读取真实密钥、调用模型、重启真实服务、提交/推送/部署或改历史 run。仅新增审查证据、归档上一任务并更新下一任务。

## 2. 已完成的部分，不重复返工

R6-F01 health 的十类合同、R6-F02 发布文案静态 digest、R6-F03 混合输入的实际模型绑定、R6-F04 四个适配器的 prepared-operation 恢复，已通过上述相应独立行为检查。此前重复审计、原任务只读观察、错误身份拒收等安全边界也保持通过。

这支持“这些指定边界已修复”，不支持“十个角色的所有配置组合、创作品质和真实成片已经通过”。当前没有新增媒体/TTS 费用的证据，也没有本轮新片可审。

## 3. R7-F01 / P1：真实目录支持的画幅被文本任务拒绝

位置：

- `apps/studio/src/server/video-provider-settings.ts:226`：正式 Seedance 默认配置支持 9:16、16:9、1:1、3:4、4:3。
- `packages/production-pipeline/src/video-generation.ts:3`：公共类型也定义这五种。
- `packages/production-pipeline/src/production-pipeline.ts:4527`、`:5707`：当前选用模型的能力摘要进入前期构思。
- `apps/codex-broker/src/codex-executor.ts:1918`：能力摘要的 parser 却只接收前三种；treatment/script/director 共用该校验。

独立复现不是手写一个错误请求：原自有想法 run 的 initialInput → 正式 ProductionPipeline → 正式构思适配器/client → 隔离真 socket/Broker/parser。使用正式目录和默认模型画像，仅外部 executor 为拒绝外部副作用的测试替身。原选择得到：

`HTTP 400: payload.brief.productionCapabilities.assetProviders[3].aspectRatios contains an unsupported ratio.`

executor=0，约 0.18 秒；删掉 Seedance 仅作诊断对照后 executor=1。单独正式目录投影也复现 Seedance 拒绝，MiniMax/Wan 接受。source/dist 一致。实际 QA 的原始 400 正文未保存，故这里是原输入和正式配置重放的根因证据，不伪称取回了已丢失的原 HTTP 报文。

含义：尚在写构思、最终也选竖屏，仅因为可用能力表包含另两种合法画幅，就完全无法开工。不是水杯题材错误，不是 GLM/Codex 服务坏了，也不是“role digest 应等于 task digest”。

修复边界：能力清单与本次选定输出比例分开校验；正式目录已支持的五种合法能力必须能进入三个规划角色，未知比例仍拒绝。不要关 Seedance、截掉真实能力或放宽任意字符串。输入规则变化要更新 descriptor/pin 及所有受影响消费者。

## 4. R7-F02 / P1：系列事实合同自相矛盾，额外调用已有实证

位置：`codex-screenwriter.ts:409` 强制系列 1–8 条 canonFacts；`task-definitions.ts:312` 同样要求。后续 `production-pipeline.ts:9000` 和 `:9216` 还分别在脚本物化/最终审查前拒绝空事实。不是只改编剧这一行就结束。

系列真实 run 的第二轮独立审计明确允许“没有新增已建立事实时保持为空”。第三轮 produce 按此返回后，宿主触发：

`Series script drafts must contain between 1 and 8 canonFacts.`

该错误直接进入下一次 `validation-repair` 的真实 prompt；这次额外调用 providerWaitMs=67742。最终候选又塞入“本集的验证对象是……”作为事实，并未补到实验结果。事实要求和输出数量要求在相互抵消。

修正方案：系列事实字段必须存在且为数组，但允许 0–8 条；没有已建立事实可以为空，不能为凑数量新增事实。稿件、物化、终审、系列记忆提取和 UI 统一；空本集新增事实不能删除已有 Canon，也不能跳过终审或其它质量要求。

新探针以抽象表达系列的空事实数组复现，不依赖手机题材。这是纠正事实完整性合同，而不是降低事实质量。

## 5. R7-F03 / P1：审计“知道该找上游”，程序却继续命令原角色重写

真实系列 run：`run-732178ce-3d5a-4f93-8e8f-b3da53bfd600`。只具备通用 Pexels 能力，承诺却是展示同一手机两轮真实 15 分钟受控实验和结果；未提供实验记录。

1. 构思把采集、对照条件、计时和真实读数风险列在 feasibilityQuestions，审计 96 分通过。
2. 编剧首次审计即明确指出必须上游提供真实测试证据/采集能力，或由用户调整承诺。编剧自身不能制造这些输入。
3. 程序仍把全部 repair 反馈交回编剧；第二轮改成空表自测教程，第三轮仍未兑现实测承诺。评分 57 → 46 → 38。

这是局部架构缺口，不只是措辞问题：

- `role-agent-loop.ts:429` 附近只有 pass 返回、否则同角色 revision；`validateRoleAudit` 只有文字 issue，没有可执行的责任/干预判定。
- `creative-planning.ts:673`、`:682` 在 treatment/script port 成功后向下推进；既有 needs_source/needs_user 分流是在更后的 availability review（约936行）。早期角色内部的阻断没有到达该分流。
- `production-pipeline.ts:5711` 构思 suppliedSources 恒为 []；构思实际 brief 也没有 visualProof/visualPlan。不能把尚未声明的用户采集能力当作存在，亦不能把“普通图库还没搜索”一概判为不可制作。

技术方向：让现有规划角色的独立审计输出一个机器可读的“本角色可修 / 缺来源 / 需用户决定”处置，宿主验证后接入既有规划 halt/编辑入口。明确非本角色可解的 blocker 不再触发本角色第二次 produce，不自动 backup；普通措辞、节奏问题仍允许有界本地修订。无需再增加一个模型角色、推翻图或新建任务平台。

构思本身可以是合格的“有条件方向”，但其核心外部前提未满足时不能被当作“已可开工”。保持用户已锁定承诺；改成教程是用户选择，不能偷偷改。普通可搜索图库、机制示意、纯视觉表达不因尚未物化而全部被挡住。方案详见 TASK 的分类与反例矩阵。

## 6. R7-F04 / P2：具体拒绝原因被丢掉，影响排查和用户动作

Broker 在本地 socket 返回完整字段路径；client 的 CodexBridgeError.message 也收到它。role-loop 的 failedLoopError（约503行）改用 creatorMessage，节点持久化后只剩“合同不一致，请查看诊断信息”。在正式管线重放里，run 序列化内容不包含 aspectRatios，checkpoint 没有该原始原因。

这解释了执行端为什么只写了 payload/digest/binding 三种猜测，但不能成为不调查根因的理由。应保留**脱敏、受限的诊断码/字段路径/HTTP 状态/任务身份**，用户摘要与技术详情分开；不记录 token、整份 prompt、图片正文或任意原始上游响应。输入拒绝不应给用户换模型或原样重试的暗示。

## 7. 慢的实际组成，以及不能照信的审计意见

总 13m53.812s；构思 produce 47.231s + audit 24.107s；编剧 produce 512.473s + audit 249.774s。两个角色合计 833.585s，几乎等于总耗时。OpenAI 9 次调用、队列等待0、Provider retry0、session rebuild0；现有证据不支持继续归因 socket 或排队。

主要可消除的耗时是：上游条件不满足仍进入多轮局部修订、互相矛盾的校验造成结构修复。单次模型工作本身仍有数十秒到三分钟；目前 trace 只能定位到 Provider 执行段，不能进一步断言是首 token/推理/解码哪一段，不能保证消除所有等待。

另一个审计准确性问题：第一版镜长是 `[2.5,3.5,4,3.5,3.5,5,2.5,3.5,2.5,3.5]`，实际总计 **34**，审计却写 **34.5** 超范围。代码校验34秒通过是正确的。下轮给审计提供宿主计算的当前候选时长/数量/合法性事实，算术由代码负责；但不能据此忽略真正的单镜动作过密、证据不足问题，也不增设“审计的审计”模型套娃。

暂停当前以整个 creative-planning 节点为边界，页面亦说明等步骤完成；因此不会立即阻止内部下一轮模型。它是已知易用性局限，不把它偷偷改成新取消语义或终身调用上限。本轮先解决没有意义的重复修订，并把真实调用次数/等待阶段说明白。

## 8. 为什么已经七轮还没结束

不是“每次修一个，必然自然冒出另一个”的正常现象。当前有三层原因：

- 分散维护的合同未形成实际配置组合的闭环：上次 health/digest 等被查出，这次正式 Provider 目录里的能力字段仍未覆盖。部分跨包测试给 productionCapabilities.assetProviders 填 []，刚好绕过了真正差异。
- 创作质量提示写了“必要时交上游”，控制代码没有对应出口；同时事实质量规则与硬校验冲突。安全恢复机制完善不能替代创作编排有效。
- QA 每次都被前半段阻断，后半段未验证列表几乎不缩短。页面健康分和几百条回归容易遮住这一事实。

上轮资料包足以修那四项特定问题，但不足以叫“全链路收口资料包”。本审查窗口此前没有把真实目录配置和“不可在当前角色解决的质量失败”转成足够具体的验收，审查与任务设计也有责任。修正不是再堆审计次数，而是增加能捕捉这些漏口的有限行为证据，并改变 QA 样本分工。

## 9. 下一包的边界与放行条件

TASK revision 8 只围绕上述四个根因、必要上下文与相应验证。合并修、集中测，不为每项等审计。纯接口规则与零事实改正先建立红灯；非局部阻断必须从正式角色/图/Studio 被消费，不能只加 prompt。

真实 QA 分正负两路：已知缺实验来源的输入用于验证早停；另选在当前能力内有明确观看价值的真实创作方案，负责走到报价、媒体、成片、双审和必要返工。不能给不可执行输入反复换题/模型碰运气，也不能拿负例停住证明生产成功。后半段的确定性组合验证独立进行，不再所有测试都等模型先写出合格选题。

不能承诺下一轮绝不会发现新问题。下一轮可以被称为有效收口的前提，是根因复现转绿且未验证的真实后半程明显减少；如果仍无新片，要如实交回具体阻断，不宣告项目完成。

证据：`evidence/r7-capability-contract-review.mjs`、`evidence/r7-series-trace-review.json`、`evidence/r7-review-checks.json`。完整命令终态归档在同 evidence 目录。现有历史报告不改写；本报告修正其原因判断。
