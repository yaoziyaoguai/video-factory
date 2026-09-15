# revision 6 统一复审与集中修复依据

裁定：**CHANGES_REQUIRED**。R5-F01 重复审计修复可以接受；正式生产仍不能放行。以下四项一次性处理，完成集中回归后继续真实本地 QA，不为每项另开审计。

## 1. 核验范围与结论

- 仓库实际路径：`/Users/jinkun.wang/work_space/veidofactory`；HEAD `570fe6e59e072c4965c86769bf2096825f003383`，分支 `codex/final-dual-review-cloud-acceptance`。
- 相对 `evidence/r6-start-baseline.json` 的 324 个文件，仅 `role-agent-loop.ts` 与其正式测试变化，0 个缺失。没有把既有 A/B/C dirty diff 算成 revision 6 工作量。
- 完整阅读 RESULT revision 6、TASK revision 6、第四/第五轮真实 QA、有关验收合同、role-loop 实现与当前真实接口。Graphify 仅查询旧图定位；根因以源码、正式构建及独立行为证据为准。
- 本窗口独立回归：恢复边界 **39/39**；Broker/合同/Studio probe/发布文案现有测试 **75/75**；pipeline 类型检查 exit 0。
- 新增跨边界探针：源码 **5 pass / 10 fail**，正式 dist **5 pass / 10 fail**，两次均 exit 1。10 个失败对应下文四类缺陷，**不是新增十个业务需求**。
- 真实两个 socket 的只读复核：均支持 10 类任务、只发布 5 类 digest；正式 Studio probe 均 unavailable；active/queued/completed/failed 均为 0。没有提交真实任务。
- 未独立重跑全仓全量、Python、浏览器 QA 或真实模型。RESULT 中这些证据保持其原有来源，不冒充本窗口复测。

R5-F01 修复让 `executeOperation` 返回真正产出结果的 operation contractDigest，外层不再用执行前的旧快照判断。当前合同 pass 只审一次、新失败停止、中断观察原任务、producer 不重跑，以及先前三项安全边界均通过独立回归。不要再次重做这一块。

## 2. 为什么“测试全绿，正式环境仍受阻”

不是模型性能结论，也不是又有一个题材需要补丁。当前主要是**模块之间的真实合同没有在组合测试中闭合**：

1. Broker 的 health 测试明确断言五个 digest；Studio 的 ready 测试手写十个 digest；没有把正式 health 交给正式 Studio probe。
2. digest 同步测试只测无 platform 参数的 descriptor；executor 真正执行时却使用带 platform 的 descriptor。
3. ZAI 的健康身份按 task kind 选模型，实际执行按是否有图片选模型；两个单测分别把不同规则固化为正确答案。
4. role-loop 的恢复机制已实现，但四个角色适配模块仍丢弃其 beforeSubmit / preparedOperation；只测编剧正式恢复不能证明其它角色已接入。

**需要局部修正协议边界与调用接线，不需要重建工作流、增加数据库/缓存/框架。** 本资料包将“代码里存在某能力”改为“正式调用链确实经过它”的验收。

## 3. R6-F01 / P1：health 合同清单不完整

位置：

- `apps/codex-broker/src/broker-server.ts:286`：另写五项白名单。
- `apps/codex-broker/test/broker-server.test.ts:326`：测试也只期待五项。
- `apps/studio/src/server/codex-provider-settings.ts:240`、`:278`：正式消费者要求声明支持的任务都有正确 digest。
- `apps/studio/test/codex-provider-settings.test.ts:123`：手写 ready health。

独立证据：OpenAI/ZAI 全任务身份均 10 kinds / 5 contracts → unavailable；仅声明 script-draft + role-audit 的合法子集均可用；所有 health 探测 executor=0。十项 descriptor 与 pipeline pin 本身全部相符，不能误修为更新五个 hash。

影响：三入口到制作的能力门禁被全部阻断。对应 QA-R6-01、G01/G08/E01。

最小修正：从正式 `BROKER_TASK_KINDS` 与 executor 实际 taskKinds 的交集生成 health 合同，不再维护第二份受保护任务子集；不通过删除 taskKinds 或放宽 Studio 校验解锁。默认 profile 必须全量可用，合法任务子集仍只暴露实际支持项。

测试：真实 `CodexBrokerServer` + 真 Unix socket + 正式 `read*ProviderSettings`，不得手写成功 health；再覆盖缺失/错误 digest 的负例和正式 dist。已有手写 HTTP fixture 可保留用于故障注入，不能作为唯一正例。

## 4. R6-F02 / P1：平台文案成功输出被自己的合同检查拒绝

位置：

- `apps/codex-broker/src/task-definitions.ts:237`、`:322`、`:899`：平台规则进入 prompt，prompt 又进入 digest。
- `apps/codex-broker/src/codex-executor.ts:512`：请求按不带 platform 的 digest 受理；`:751` 开始按平台计算执行 descriptor。
- `apps/codex-broker/src/zai-code-plan-executor.ts:88`：同样按平台计算。
- `apps/codex-broker/src/broker-server.ts:141`：执行完成后发现 digest 不一致，拒收。

独立证据：正式 writer → client → socket → Broker parser/durable → **实际 ZAI executor（只注入 HTTP 模型响应）** → 完成查询。抖音、视频号、快手、小红书、B 站各有且仅有一次 transport 调用，合法输出仍得到 completed_failure/422、reasonCode=contract_mismatch；未知平台中性路径通过。源码/dist 一致。OpenAI 的相同计算路径已读源码，本窗口没有模拟其子进程作端到端实证，执行者须补这个对照。

影响：入口修好后，正常制作到发布文案仍会失败；用户可能误以为模型又出错而重试。这里没有真实外部发布或现金调用。对应 G01/A11、角色 prompt 合同同步与完整制作验收。

技术决定：`contractDigest` 表示**任务类型的静态合同**；具体 platform 属于 request payload，受 requestDigest 保护。publish-copy 的规范 digest 应覆盖通用发布提示词、完整平台规则表、默认规则、schema 与语义版本，不随某次 platform 选择变化。保留实际 prompt 中的平台差异及 trace；不把 trace.digest 强行替换为客户端传来的值，也不删除平台规则降低质量。只更新真正变化的 canonical pin。

测试：五个现有平台 + 未知平台，OpenAI/ZAI 两种实际 executor（外部传输替身）；初始/修订请求、正确完成与原结果重放、错误 digest 拒绝。还须证明任一平台规则修改会改变 canonical digest，平台输入改变会改变 requestDigest。

## 5. R6-F03 / P1：声明、持久化绑定与真实执行模型不一致

位置：

- `apps/codex-broker/src/zai-code-plan-executor.ts:67` 按 kind 声明，`:103` 按 images.length 执行。
- `apps/codex-broker/src/broker-server.ts:381`：持久化 binding 取静态 kind 模型。
- `packages/production-pipeline/src/codex-task-binding.ts:84`：客户端也取静态 kind 模型。
- `packages/production-pipeline/src/codex-chat.ts:882`、`:1016`：验证外层 binding/digest，但未核对成功 trace 的实际 provider/model 与 binding。

独立证据（正常返回 success，不是当前所有调用都会失败）：

| 输入 | 持久化请求绑定 | 实际传输 / trace |
| --- | --- | --- |
| role-audit 无图片 | glm-5.3 | glm-5.3（对照通过） |
| role-audit 有图片 | glm-5.3 | glm-5.3-flash（不一致仍成功） |
| asset-rank 无缩略图 | glm-5.3-flash | glm-5.3（不一致仍成功） |

影响：执行身份与恢复证据不可信，不能用绑定中的模型身份证明独立审片。当前探针没有证明两份终审意见来自同一模型，也没有证明真实重复扣费，不能扩大陈述。对应 A03/A11、G03/G06/E04。

技术决定：保留当前文字用强文本模型、图片用已配置视觉模型的策略，**不要靠全部换 Flash、删图片或改 trace 标签解决**。对已有混合输入任务补充小型、声明式的路由元数据，受理前确定实际物理 modelId；写入现有 immutable binding，执行与结果核验沿用同一身份。TASK 给出字段与范围。Broker 和客户端都拒收成功 trace 与绑定不符的结果；不得触发自动 backup/新 requestId。

测试：上述三例及有缩略图 asset-rank、视觉审片/参考片、两种配置模型 ID、自定义模型名；同请求查询/重放/重启不改身份。注入“正确外层 binding + 错 provider/model/kind 的 trace”必须拒收且调用数不增加。健康可用只是配置证据，不是双真实模型审片证据。

## 6. R6-F04 / P1：部分正式角色丢弃持久化恢复接线

位置（均存在 role-loop checkpoint，但 produce/audit 不传 requestOptions、恢复不消费 preparedOperation）：

- `packages/production-pipeline/src/asset-semantic-ranker.ts:116`、`:120`。
- `packages/production-pipeline/src/codex-visual-review.ts:635`、`:639`、`:657`。
- `packages/production-pipeline/src/reference-grammar.ts:94` 及其 audit。
- `apps/studio/src/server/series-planning-agent.ts:75` 与 `generate/reviewEpisode` 两组回调。

独立故障注入：正式 ranker → role-loop → 正式 client → 真 socket/durable，阻止受控 executor 完成，client 等待期结束。已执行 calls=1、Broker active=1，checkpoint attemptedRequestIds=1，**pendingOperation=null**。测试结束后释放本测试任务并正常关闭；不触碰真实服务。源码/dist 一致。

影响：重启、切候选或合同升级时缺少原请求的完整 envelope、绑定与路由，无法依赖既有 observePrepared 恢复；可能重新 POST 或不能取回原结果。这里实证的是快照缺失，不声称所有重试都会重复模型：同一 Broker 同 ID 的 durable 去重仍存在。

最小修正：按已通过的 creative-treatment / script / director / publish / topic 模式，把 requestOptions.beforeSubmit 传到实际 client，并在 preparedOperation 存在时只调用对应原客户端的 observePrepared。文字会话、视觉审片 stateless 审计、producer/audit 分离、原有 deadline 与质量要求保持。不要再做第二套恢复设施；必要的 client 类型/适配扩展与正式调用点一起修。

测试：四个模块的 produce 与 audit（系列含 generate/reviewEpisode），从正式适配器进入，不能直接调用裸 role-loop 代替接线验证。验证快照先于 POST、保存失败 POST=0、迟到成功/失败、客户端重建后只查原请求、上游不重跑；视觉单分支补审不增加 media/voice/render。原 R4/R5/R6 恢复边界 39 项保持绿灯。

## 7. QA 与其它历史问题的边界

- 第五轮没有提交真实模型，因此不能证明“慢已经解决”；第四轮 16m39s/19m20s 等历史耗时仍只能作背景。下一轮记录排队、produce/audit、传输/观察、校验、重试和总耗时，不凭感受改超时/降模型。
- 现有热点来源不足属于有理由的阻断，不改来源门槛；另选有证据的样本覆盖热点后段。
- 第五轮历史视频的卡片、21s 与配音24.023s不能证明新流程回归，也不能算新成片通过。下一轮只用本轮新作品完成 E03–E07。
- E06 独立页面已有浏览器证据；下一轮不重复花大量时间测未改的模板CRUD，重点补真实新 run 的状态、恢复、制作与移动端。
- “单视频×单角色终身三次机会”仍是未决定产品语义，不纳入本次实现；不取消现有有界重试、不添加全局硬费用上限。

## 8. 证据索引与复现

`evidence/r6-contract-boundary-review.mjs` 是不调用真实模型的独立探针，不是 fake Broker 服务，不得接到真实 Studio。首次调试用的一条旁白未满足既有最少三条输入合同，已在证据脚本改为合法三条；本文发布文案结论只引用更正后进入 executor 的结果。

```sh
node --test --test-concurrency=1 --import tsx docs/codex-collaboration/evidence/r6-contract-boundary-review.mjs
VF_REVIEW_DIST=1 node --test --test-concurrency=1 --import tsx docs/codex-collaboration/evidence/r6-contract-boundary-review.mjs
```

完整终态见 `evidence/r6-independent-contract-source-red.txt`、`r6-independent-contract-dist-red.txt`；已有绿灯见 `r6-independent-focused-green.txt`、`r6-independent-existing-green.txt`。命令、退出码及只读运行快照见 `r6-review-checks.json`。下一轮用 `r7-start-baseline.json`，不是重新以 HEAD 整个 dirty diff 计本轮。

本窗口只新增审查/证据和更新 TASK；未修改产品、RESULT、用户数据、真实服务；无真实模型/媒体调用，无 commit/push/部署。执行窗口按 TASK revision 7 连续集中完成四项、集中回归、真实本地 QA，最后统一交付。
