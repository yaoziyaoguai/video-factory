# Revision 11 真实本地 QA

## 结论

- CODE_VALIDATED：是。D11-01～D11-46 的确定性证据见 `docs/codex-collaboration/RESULT.md` 最新 R11 记录。
- QA状态：`QA_DONE_WITH_CONCERNS`；本轮可安全执行的真实点击和恢复检查已完成，但产品验收未通过。
- 真实完整主片：无。主片在GLM脚本任务结果无法收敛后终止，未到报价、媒体、TTS或渲染。
- 双审：未验证；没有可供两个真实视觉模型共同审查的成片与证据SHA。
- 人工终审/听感：未验证；没有成片或真实音轨。
- 费用零点：本轮新 workspace 与两个新 Broker 均从 0 开始；最终已花 `¥0.00`，在途/未知现金暴露 `¥0.00`，总止损 `¥50.00`，剩余 `¥50.00`。
- 问题汇总：11项，其中P0 2项、P1 6项、P2 3项；最高优先是结构化文本任务失败、模型切换破坏已确认上游成果，以及无远端任务身份时长时间无法收敛。

## 环境与基线

- 开始时间：2026-09-14 08:07；结束时间：2026-09-14 09:28（Asia/Shanghai）。
- 仓库：`/Users/jinkun.wang/work_space/veidofactory`；HEAD `b36ebac`；保留既有 dirty 工作树。
- 正式构建：2026-09-14 08:08 完成；Studio 加载当前 `dist`，不是开发服务器。
- Node `v26.8.1`；Python `3.12.10`；ffmpeg/ffprobe `/opt/homebrew/bin`。
- Studio：`http://127.0.0.1:4317`。
- workspace：`/Users/jinkun.wang/work_space/veidofactory/workspace/qa-r11-20260914-001`。
- OpenAI Broker：`.local/runtime/qa-r11-20260914-001/openai/worker.sock`，`gpt-5.6-sol`，xhigh，11类任务，开始 active/queued/completed/failed = 0/0/0/0。
- ZAI Broker：`.local/runtime/qa-r11-20260914-001/zai/worker.sock`，`glm-5.3`，max；视觉路线 `glm-5.3-flash`，11类任务，开始 active/queued/completed/failed = 0/0/0/0。
- 两个 Broker 的 task kinds 与 11 份合同 digest 完全一致，无 fake Broker。

## 问题列表与根因

### QA-R11-001 / P1 / Q11-02、D11-01

- 现象：自有想法入口中，界面允许填写“本片预算意向”，但点击“开始制作”返回 HTTP 400；用户只看到“制作参数不符合要求，请检查后重试”，没有字段级说明。正常制作无法开始。
- 前提：全新 R11 workspace；自有想法；20–34秒；允许AI生成；预算意向35元；MiniMax成熟女声；两个真实Broker均就绪且调用数为0。
- 步骤：保存手动机会→新建制作→填写明确内容/视觉要求→允许AI生成→预算意向35→选择MiniMax成熟女声→开始制作。
- 证据：`08-create-run-400.png`；`POST /api/runs → 400`；Studio `req-1j` 37ms；两个 Broker completed/failed 仍为0。
- 原因状态：已确认。
- 原因：`NewRunDialog.tsx` 把 `budgetIntentionCny` 写入 `StudioProductionInput` 并提交；`packages/production-pipeline/src/contracts.ts` 的 `PRODUCTION_BRIEF_INPUT_KEYS` 和 `ProductionBrief` 不接收该字段，`parseBrief` 因未知字段拒绝。`productionInputMessage` 又把真实字段错误降成泛化提示。
- 影响：任何填写预算意向的正常用户都无法创建制作；该字段对用户可见却与服务端正式合同不一致，属于主链合同缺陷。
- 重试：原请求只提交1次，未盲目重放；下一次仅清空可选预算意向，以新的合法输入继续其它独立验收，不再用带该字段的输入复现。
- 费用：已花0；最大现金暴露0；无模型或媒体在途。
- 建议最小修正：把预算意向作为正式 brief 的有界非负规划输入贯穿解析、持久化与角色输入，或在 Studio 边界显式剥离并单独持久化；不能保留“前端能填、后端必拒绝”的双合同。同时把未知字段错误映射为具体可行动提示并加真实 DTO→HTTP 回归。
- 未验证：本次首次提交未进入导演初案；后续主链改用未填写预算意向的合法输入继续测试。

### QA-R11-002 / P1 / Q11-02、D11-22、D11-23

- 现象：在导演讨论阶段生成“不替换当前稿”的备选方案后，点击“采用这个备选”，服务端已完成采用且当前方案已换成备选内容，但页面持续显示“正在处理原操作”，超过15秒仍未复位。
- 前提：主片 `run-740869da-a112-458b-b5ff-6d8d4d85b30e`；真实 `gpt-5.6-sol` 已完成初案、解释和备选讨论；媒体尚未开始。
- 步骤：点击“给我另一个方向，但先不要替换”并发送→等待真实模型完成→确认当前稿未变且出现独立备选→点击“采用这个备选”→观察页面与命令状态。
- 证据：`10-director-alternative.png`；服务端 `creative-review` 的 `draftSha256` 已变为 `3865aba4...`、`previousDraft` 保留原稿、`effectiveUserInstructions` 写入采用指令；命令 `88cfae87-34e9-4c3a-b5a0-eb061e83e078` 查询结果为 `status: completed`，但页面仍显示“正在处理原操作”。
- 原因状态：行为边界已确认，代码根因待集中修复轮定位。不是 Broker 慢：采用动作不调用模型，两个 Broker 在该操作后均空闲。
- 影响：用户无法判断操作是否成功，可能误以为系统仍在执行或尝试重复点击；违反“命令完成后恢复可操作状态”的交互合同。
- 重试：未重复采用；后续仅刷新同一页面验证持久化状态，再继续当前 run。
- 费用：导演文本调用属于订阅模型；媒体现金费用0，在途/未知现金暴露0。
- 建议最小修正：命令轮询读到 `completed` 后必须清除本地 pending command 并刷新 review；页面加载时也应以服务端命令终态收敛，不能依赖组件内短暂状态。补一条“采用完成但首次响应/刷新竞态”的 UI 回归。

### QA-R11-003 / P0 / Q11-02、E01

- 现象：确认已经采用的导演构思后，主链在该构思的首次独立 `role-audit` 处确定性失败，未进入脚本讨论，更未到报价。
- 前提：同一主片；当前构思已由用户确认；OpenAI Broker 11类合同摘要与 Studio 完全一致；Broker 在确认前空闲。
- 步骤：刷新已完成的采用状态→点击“确认当前方案，继续”一次→等待8.2秒。
- 证据：`11-treatment-audit-failure.png`；OpenAI Broker durable request `agent-0c584891a93352dede5b6543ae8f4702a4a57ed83f96802cce5e136d067c6236` 为 `kind=role-audit`、`status=422`、`category/reasonCode=invalid_request`、`providerWaitMs=7742`；agent loop trace `status=failed`、`producerModelCallCount=0`、`auditModelCallCount=1`、`pendingCandidate` 完整保留；Broker `failed=1`、无 active/queued。
- 原因状态：已定位到真实 OpenAI `role-audit` 执行边界，但 Broker 当前只持久化脱敏后的分类，没有保留可审计的 provider 错误摘要，因此无法从本次证据再区分“上游请求拒绝”与 CLI 参数/模型路由拒绝。可以排除合同 digest 不一致、客户端连接中断、并发、重复提交和媒体 Provider。
- 影响：P0 主链阻断；一个结构合法且已确认的导演构思无法进入脚本阶段。
- 重试纪律：没有原样重试。后续只按页面现有模型切换路径把失败所属的构思阶段改为GLM-5.3，并用一次新身份恢复；GLM构思与独审成功，脚本随后进入QA-R11-006，不再重放。
- 费用：文本订阅调用；媒体现金费用0，在途/未知现金暴露0。
- 建议修正方向：集中修复轮需让 Broker 在不泄露敏感内容的前提下持久化 `providerErrorCode` 与安全摘要；并为正式 OpenAI `role-audit` 建立 source/dist 跨进程 canary，避免把所有 provider 400/422 压成不可诊断的 `invalid_request`。

### QA-R11-004 / P1 / Q11-02、D11-36～D11-38

- 现象：同一次失败的用户解释互相矛盾：页面阶段项写“脚本 未通过”，错误正文写“导演前期构思的独立审计失败”，状态又写“第1轮 AI 创作中”；调用统计显示“创作0次、审计1次”，但耗时区写“本次1次已证实模型执行、此前累计3次”。运行文件中的 `creativeReviewOperations.confirm.status=failed`，节点 `output.continuationOperation.status` 却仍是 `running`。
- 证据：`11-treatment-audit-failure.png`；主片 `run.json` revision 4；agent loop trace attempt-5。
- 原因状态：确认是状态投影/文案归属错误，不是模型仍在运行；两个 Broker 均 active=0、queued=0。
- 影响：用户无法判断究竟哪个阶段、哪个角色、哪种调用失败，也无法可信理解耗时与调用数，容易错误重试或切错模型。
- 建议最小修正：以 `waitingStage/pendingOperation.phase` 和终态 operation 为唯一阶段事实源；失败后不得保留“创作中”或 running continuation；“本次”与“此前累计”必须明确是否包含导演讨论调用，并让阶段标签与实际失败角色一致。

### QA-R11-005 / P0 / Q11-02、D11-24、D11-27

- 现象：构思审计失败后，仅把“下次使用脚本模型”从 gpt-5.6-sol 改成 GLM-5.3 并保存，系统先把整个创作规划标成旧结果；点击“按人工版本继续生成”后，已经讨论、采用并由用户确认的导演构思被恢复成最初原稿，讨论记录、备选与采用结果从当前 review 消失，页面重新要求确认构思。
- 证据：`12-script-model-change-invalidates-treatment.png`；保存后 UI 明确同时显示“改脚本保留构思”和“前期构思 待开始”；继续后当前稿从已采用方案 `3865aba4...` 回退为最初方案 `f102c0db...`，review 显示“第1版讨论/还没有讨论”，但脚本模型已为 `glm-5.3`。
- 原因状态：行为已确认，代码根因待集中修复轮定位。不是用户改了构思，也不是旧稿未持久化：切换前 `creative-review`、`creativeReviewOperations`、`previousDraft` 均有完整持久化证据。
- 影响：违反“改脚本保留构思”的核心产品承诺；用户多轮导演协作结果可被下游模型切换静默回退，存在严重作品语义和信任风险。
- 重试纪律：没有继续用脚本模型切换恢复旧构思；只把失败所属的“前期构思模型”切换为GLM-5.3，接受该阶段重新生成并执行一次，随后按QA-R11-006停止。
- 费用：文本订阅调用；媒体现金费用仍为0。
- 建议修正方向：模型选择必须是 stage-scoped input version；script model 变化的失效边界从 script 开始，treatment 的 effective confirmed revision、discussion history 与 adopted proposal 必须保留。加入真实状态序列回归：treatment 讨论/采用/确认→script 模型切换→继续→treatment SHA 与确认态不变。

### QA-R11-006 / P1 / Q11-02、Q11-10、Q11-12、E01

- 现象：将失败所属的构思与脚本明确切换为 GLM-5.3 后，GLM 构思生成和独立审计均真实成功；随后脚本任务运行约4分钟后 Broker 已无 active/queued 且 `failed` 从0变1，但 durable task 一直停在 `state=accepted`、无 outcome。Studio 先进入 `accepted_unknown`，查询原任务一次仍没有结果；直到操作受理后 `42分59秒`，Studio 才按本地观察期限把确认操作收敛为失败。Broker 原任务截至本轮结束仍是 `accepted`，没有可消费终态。
- 前提：ZAI Broker `glm-5.3` max；构思 producer `117901ms`，构思 audit pass 88；随后开始唯一 `script-draft` 任务 `agent-e9fc146b34379bc729eb6f0cfcce4ff30586ce59be714157986fc13d6287ed60`。
- 证据：`13-glm-script-accepted-unknown.png`、`38-desktop-run-recovered.png`；ZAI Broker health 最终为 `active=0, queued=0, completed=2, failed=1`；对应 durable JSON 最终仍为 `state=accepted` 且 `outcome` 缺失。Studio run revision 9 最终为 `status=failed`；confirm operation `d261458f-...` 从 `acceptedAt=08:38:08` 到 `finishedAt=09:21:07`，正好 `42分59秒`。页面刷新后保留“查询原任务”入口，并把这段等待计入该步骤总耗时。
- 原因状态：代码语义已确认，触发它的底层网络错误摘要未持久化。`ZaiCodePlanExecutor` 对未收到响应头且不是 ENOTFOUND/ECONNREFUSED 的连接/超时异常统一设置 `outcomeUncertain=true`；`BrokerServer.executeDurableTask` 对 uncertain 故意保留 accepted record，因此 Provider 实际已断开后没有可收敛终态。当前协议也没有上游 task-id 可供继续查询。
- 影响：真实运行不会在 Studio 中永久显示进行中，但会让用户等待约43分钟才得到本地失败，而且底层原任务仍无终态，用户依旧无法知道失败原因或安全决定是否新建任务。该模式阻断脚本、报价、媒体、配音、渲染和双审，并显著放大“文本节点异常缓慢”的体感。
- 重试：没有重放 script。只按产品提供的“查询原任务”执行一次只读观察；结果仍 unknown 后停止该主链。
- 费用：文本订阅调用；媒体/TTS费用0。由于这是文本 Provider，不计现金未知暴露；但模型执行结果未知。
- 建议修正方向：区分“有可查询的远端 task identity”与“仅同步连接断开”。没有远端查询凭据的同步 API 不能让 Broker durable 永久保持 accepted，也不能把43分钟本地观察当作唯一恢复机制；必须持久化安全的底层 error code/headers-received/attempt timing，并明确何时可用新 request identity 恢复。UI 在 Broker 已空闲、原任务长期不更新时应显示真实观察期限和剩余动作，不能继续写“创作中”。

### QA-R11-007 / P1 / Q11-06、Q11-12

- 现象：真实刷新热点后，OpenAI `topic-ideas` 在约11.5秒后以 HTTP 422 `invalid_request` 终止；页面退化为12条规则候选，全部标记“待补来源/尚未总编评估”，没有任何可采用候选。随后在独立系列入口采用首集时，系列开拍总编的 OpenAI `role-audit` 也在约11.1秒后以相同422分类失败，页面只显示“服务暂时无法完成请求，请稍后重试”。
- 前提：全新 R11 workspace；7个平台、12条热点信号；OpenAI Broker 的11类合同摘要与 Studio 一致，刷新前 Broker 空闲。
- 步骤：在热点入口点击一次“立即刷新热点”并等待刷新完成；没有再次刷新或重放失败任务。
- 证据：`15-trend-fallback-and-source-status.png`、`17-series-roadmap.png`、`18-series-review-failure.png`；热点 durable request `agent-b46a59e555925e3cce731c7c85ee8fc6a1059caad63794d11338173067d529a2` 为 `kind=topic-ideas`、HTTP 422、`invalid_request`；系列采用 `POST /api/candidate-inbox/series-series-4a60f62c-ba28-4a9d-a067-5a7e0c15220f-episode-001/adopt` 返回500，内部 `role-audit` 为 HTTP 422、`invalid_request`、`providerWaitMs=10502`；OpenAI Broker 随后 `active=0, queued=0, completed=3, failed=3`。热点候选保留 `generationFallback=model_error`，系列候选仍为待采用。
- 原因状态：共享故障边界已确认，Provider具体拒绝原因待查。
- 原因：同一 OpenAI Broker 已在 `role-audit` 和 `topic-ideas` 两种不同任务上返回相同的422分类，合同digest一致，故障跨任务复现；更可能位于共享的结构化请求、Schema或CLI执行配置，而不是某条热点内容或单一角色的偶发语义失败。现有 durable 记录仍缺少安全的上游错误摘要，无法继续区分。
- 影响：热点刷新只能得到规则回退候选，系列也无法通过开拍复核；两个入口都无法走到导演讨论。系列页面没有指出失败角色、实际模型或切换入口，反而提示稍后重试，容易诱发同输入盲重试；同时证明 QA-R11-003 不是单一主片内容特例。
- 重试：热点只刷新1次，系列首集只采用1次；不再刷新热点、不重新采用首集、不重放失败任务。
- 费用：订阅文本调用；媒体/TTS费用0，在途/未知现金暴露0。
- 建议最小修正：将 OpenAI 结构化任务的共同请求构造与实际 CLI 支持参数做一次集中对齐，并持久化不泄密的上游错误码/摘要；用至少 `role-audit` 与 `topic-ideas` 两个正式跨进程 canary 验证，而不是分别打补丁。
- 未验证：热点真实总编生成、不同角度的真实模型发散、热点或系列保存/采用后进入导演讨论，以及第二文本模型在系列正链上的实际路由。

### QA-R11-008 / P1 / Q11-06

- 现象：本次刷新为9个可读取URL建立了正文缓存，但9/9全部 `readStatus=failed`，段落为空；失败原因完全相同：`Invalid IP address: undefined`。系统实际上没有读到任何一篇文章正文。
- 前提：同一次热点刷新；URL横跨少数派、抖音、36氪、B站、今日头条、知乎、澎湃新闻和IT之家，不是同一站点故障。
- 步骤：刷新完成后查看页面来源状态，并核对本轮 workspace 的9份正文缓存；不额外请求或轰炸URL。
- 证据：`15-trend-fallback-and-source-status.png`；`workspace/qa-r11-20260914-001/cache/trend-articles/*.json` 共9份，均为 `extractorVersion=readability-v1`、`readStatus=failed`、`reason="Invalid IP address: undefined"`、`paragraphs=[]`。
- 原因状态：共同失败边界已确认，具体实现根因待集中修复轮定位。
- 原因：不同域名在同一时间全部于IP校验层报 `undefined`，可排除单站反爬或正文结构差异；故障位于共享的主机解析/SSRF校验输入或解析结果交接。页面能诚实显示“待补来源”，但没有把“正文读取系统性失败”与普通来源不足区分开。
- 影响：热点到选题仍主要依赖标题和榜单元数据，无法满足“先读文章再发散”；涉及真实性的候选全部无法形成可靠来源证据。
- 重试：本次只使用首次刷新自然产生的9份缓存，不再请求相同URL。
- 费用：正文读取与本地缓存不产生媒体/TTS费用；已花0，在途/未知现金暴露0。
- 建议最小修正：集中修复共享DNS解析结果到IP安全校验的合同，并覆盖IPv4/IPv6、多地址、重定向和解析失败；错误态要区分“正文读取系统故障”与“该候选来源天然不足”。
- 未验证：至少一篇真实文章正文、摘要事实与原文匹配，以及正文缓存命中不重复读取。

### QA-R11-009 / P2 / Q11-09、Q11-11

- 现象：声音页的“内容声音方案”看起来只是在选择语速、停顿和声音质感，但从“生活清单”切到“人物纪实”时，当前音色从 `Tingting` 静默变成 `Meijia`；再切回“生活清单”后，参数恢复为185字/分、1.0×、自然，但音色仍停留在 `Meijia`，不会恢复原音色。页面没有提前说明预设会改演员，也没有列出变更摘要。与此同时，“云端演员”列表中的每个演员没有显示实际 Provider/计费来源，当前系统音色只以“当前所选声音不属于这个分类”保留显示；用户无法在声音区核对 MiniMax、Kokoro、macOS 的实际路由与哪些微调参数真正生效。
- 前提：当前默认音色 `Tingting`，声音方案“生活清单”，185字/分、停顿1.0×、自然；只做未保存的界面操作，不调用TTS。
- 步骤：打开声音演员→展开高级微调→点击“人物纪实”→观察音色和参数→点击“生活清单”→切换到“云端演员”。
- 证据：`20-voice-settings.png`、`21-voice-advanced-settings.png`、`22-cloud-voice-providers.png`；切换中“设为制作默认”变为可用，证明这不是只读推荐说明，而是会写入配置的实际变更。
- 原因状态：用户可见行为已确认，内部绑定原因待集中修复轮定位。
- 影响：用户可能只想改变节奏却在不知情下更换声音演员；也无法在保存前确认哪个 Provider 会执行、是否计费，以及所选语速/停顿/质感是否被该 Provider 支持。与“声音界面明确哪些设置实际有效”的目标不符。
- 重试：只切换一次并切回原声音方案；未点击保存、未试听、未调用TTS。
- 费用：0；无在途任务。
- 建议最小修正：声音方案如果包含音色推荐，必须在点击前写明并在点击后列出“将改变音色/语速/停顿/质感”；若只应改变节奏则不得改 actorId。每个演员显示实际 Provider、计费类型和有效参数，禁用或解释 Provider 不支持的微调；保存前给出最终执行摘要。
- 未验证：真实TTS、receipt、音频听感，以及修改声音后对规划节奏和已购买媒体保留边界的影响。

### QA-R11-010 / P2 / Q11-11

- 现象：模板工坊已经明确标注“模板暂停用于新制作”，但制作复盘首页仍把“先看哪些模板更容易过审”作为页面首要说明，并展示“模板表现 / 哪种讲法更容易过审”和“调整模板”入口；当前唯一中断又被页面表述为“先解决重复出现的制作阻塞，再扩大选题和模板实验”。
- 前提：R11 当前产品决定是模板继续保留、可增删改，但不参与新制作；本 workspace 只有一条因文本模型链路故障中断的主片，没有任何终审或成片样本。
- 步骤：打开“制作复盘”，查看首屏说明、下一轮行动与模板表现区域；未修改任何模板或制作记录。
- 证据：`39-desktop-experiments.png`；同轮模板页 `28-mobile-template-page.png` 明确显示“模板暂停用于新制作”。
- 原因状态：用户可见内容矛盾已确认；未检查内部实现。
- 影响：用户会误以为模板仍是当前生产与爆款优化的核心杠杆，并可能被引导去调整一个已暂停参与制作的功能；同时把纯技术阻断和“模板实验”放在同一建议里，削弱复盘建议的可信度。
- 费用：0；无模型或媒体任务。

### QA-R11-011 / P2 / Q11-11

- 现象：在全局搜索输入“声音”，唯一结果是“素材库 / 检索画面、声音与授权记录”，没有返回真正用于选择演员、语速、停顿和 Provider 的“创作设置”声音区域。
- 前提：390px；当前位于模板工坊；搜索框已自动获得焦点。
- 步骤：点击顶部搜索→输入“声音”→查看结果→按 Escape 关闭。
- 证据：`29-mobile-search.png`；操作后控制台无错误，Escape 可正常关闭。
- 原因状态：用户可见搜索召回错误已确认；未检查内部索引实现。
- 影响：想修改配音设置的用户会被带到只读素材/授权记录，找不到真正入口；这与降低使用门槛的目标冲突。
- 费用：0；无模型或媒体任务。

## 覆盖矩阵

| 用例 | 状态 | run/证据 | 缺口 |
| --- | --- | --- | --- |
| Q11-01 正式环境、登录与能力 | PASS | `01-login.png`、`02-home.png`、`03-settings.png`、`04-role-models.png`；两个Broker health | 无 |
| Q11-02 主片三阶段讨论确认 | BLOCKED_WITH_ISSUES | `05`～`14`、`36`～`38`；run `run-740869da-a112-458b-b5ff-6d8d4d85b30e` | 导演构思的解释、备选、采用和刷新保留已验证；OpenAI独审失败，GLM恢复后脚本原任务无终态，未到脚本讨论和分镜讨论 |
| Q11-03 报价与三种用户选择 | BLOCKED / NOT_VERIFIED | 主片在创作规划失败，媒体账本0 | 未产生真实报价，三种动作及旧报价失效均未验证 |
| Q11-04 真实媒体、声音与成片 | BLOCKED / NOT_VERIFIED | 素材库 `23`、`32`、`35` 为空；媒体/TTS账本0 | 未到付费边界，未调用媒体、TTS、渲染，未生成成片 |
| Q11-05 双真实审片与局部返工 | BLOCKED / NOT_VERIFIED | 无成片、无evidence SHA | 两个真实视觉模型、综合意见、返工预填与局部不变范围均未验证 |
| Q11-06 热点原文与发散 | FAIL / PARTIAL | `15-trend-fallback-and-source-status.png`；9份正文缓存 | 真实刷新完成，但正文9/9系统性失败，OpenAI总编422，只有规则回退候选 |
| Q11-07 系列与第二文本模型 | BLOCKED_WITH_ISSUES | `16`～`18`；系列 `series-4a60f62c-ba28-4a9d-a067-5a7e0c15220f` | 系列和6集路线图持久化；首集采用时OpenAI独审422，未进入导演讨论，也未证明第二模型正链路由 |
| Q11-08 真实缺证据负例 | BLOCKED / NOT_VERIFIED | 未新建模型任务 | 两条真实文本路径已系统性失败；为避免制造无意义调用，未启动该负例，只有D11确定性证据 |
| Q11-09 配置、素材路线与声音 | PARTIAL_WITH_ISSUE | `19`～`22` | 模型分组与声音界面已检查；声音预设静默换演员且Provider/有效参数不透明；未执行TTS或自然图库no-match |
| Q11-10 刷新、两窗口与本地重启 | PARTIAL / NOT_VERIFIED | `13`、`14`、`36`～`38`；主run revision 9；系列和模板持久化文件 | 刷新、重新打开、主run/系列/模板持久化通过；因底层原任务仍accepted，按纪律未重启Broker；没有安全等待gate可做两窗口冲突 |
| Q11-11 全站可用性与移动端 | PARTIAL_WITH_ISSUES | `23`～`39`；390px和1440px；控制台0错误 | 三入口及主要页面可达，模板CRUD、搜索焦点/关闭、移动端无横向溢出；模板复盘定位和“声音”搜索召回错误；真实素材展开、报价、成片、交付下载仍被主链阻断 |
| Q11-12 耗时、调用与费用 | PARTIAL_WITH_ISSUES | 两个Broker durable记录、health、run操作时间 | 9个物理文本任务可关联；媒体费用0；OpenAI失败缺上游安全摘要，GLM脚本缺outcome，UI阶段/调用/耗时解释不一致 |

## 费用与在途台账

| run/操作/授权 | 类型/实际模型 | 最大授权 | 已确定费用 | 在途/未知暴露 | 证据 |
| --- | --- | ---: | ---: | ---: | --- |
| 创建主片首次失败请求 | 本地HTTP校验，未到Broker | ¥0.00 | ¥0.00 | ¥0.00 | `POST /api/runs` 400，Broker 0调用 |
| 主片导演初案、解释与备选 | `gpt-5.6-sol` xhigh，订阅文本 | ¥0.00 | ¥0.00 | ¥0.00 | 3个completed物理任务；未调用媒体 |
| 主片OpenAI构思独审 | `gpt-5.6-sol` xhigh，订阅文本 | ¥0.00 | ¥0.00 | ¥0.00 | 1个completed_failure，HTTP 422包装 |
| 主片GLM构思、独审与脚本 | `glm-5.3` max，订阅文本 | ¥0.00 | ¥0.00 | ¥0.00现金 | 2个completed；脚本执行计入Broker failed但durable仍accepted。文本结果未知，不构成现金暴露 |
| 热点总编与系列开拍独审 | `gpt-5.6-sol` xhigh，订阅文本 | ¥0.00 | ¥0.00 | ¥0.00 | 各1个completed_failure；无媒体调用 |
| 热点正文读取与缓存 | 本地网络读取 | ¥0.00 | ¥0.00 | ¥0.00 | 9/9 failed；不计媒体费用 |
| 图片、视频、TTS、渲染、审片、返工 | 未到达 | ¥0.00 | ¥0.00 | ¥0.00 | 无quote/scope/receipt/ledger |
| **本轮合计** | R11 QA | **¥50.00总止损** | **¥0.00** | **¥0.00现金** | 剩余可用止损 **¥50.00**；不能跨轮自动复用授权 |

去重口径：以 durable `requestId` 计物理文本任务，共9个；轮询和页面刷新不算新调用。GLM脚本原任务结果未知，但属于订阅文本调用，未占现金止损；没有任何媒体父scope或子请求需要去重。

## 主片逐阶段记录

1. 内容简报：首次包含预算意向35元时在HTTP输入边界400，未调用模型；清空该可选字段后成功建立主片。
2. 导演构思：OpenAI真实生成初案。用户先请求解释，再请求不替换当前稿的备选；原稿在采用前保持不变，采用动作服务端成功并保留上一版，但页面没有及时退出处理中。
3. 构思确认：采用稿SHA `3865aba4...` 的OpenAI独立审计在7.742秒后失败；页面把失败阶段、角色、进度和调用数投影成互相矛盾的状态。
4. 模型调整：只改脚本模型时，已讨论、采用并确认的构思被错误失效和回退。随后明确把构思与脚本切到GLM，接受重新生成构思。
5. GLM构思：producer 117.901秒完成；独立audit 117.615秒完成并通过。确认后仅开始脚本，没有媒体调用。
6. GLM脚本：原任务 `agent-e9fc146b34379bc729eb6f0cfcce4ff30586ce59be714157986fc13d6287ed60` 没有远端可查询身份；Broker执行计为失败但durable始终accepted。Studio先显示accepted_unknown，42分59秒后收敛为本地失败，刷新后状态与查询入口保留。
7. 脚本讨论、分镜与画面方案讨论、三次正式确认、报价、媒体、预检、声音、渲染、双审、终审及局部返工：均未到达，不能用确定性测试冒充真实验收。

## 耗时与调用解释

| 物理任务 | 实际模型/effort | Provider等待 | 首个输出 | Token证据 | 结果 |
| --- | --- | ---: | ---: | --- | --- |
| 主片构思生成 | gpt-5.6-sol / xhigh | 85.290秒 | 3.658秒 | prompt 24,454；completion 4,222；reasoning 2,759 | completed |
| 导演解释 | gpt-5.6-sol / xhigh | 18.015秒 | 2.879秒 | prompt 25,820；completion 409；reasoning 38 | completed |
| 导演备选 | gpt-5.6-sol / xhigh | 45.502秒 | 0.800秒 | prompt 25,611；completion 2,220；reasoning 478 | completed |
| 主片构思独审 | gpt-5.6-sol / xhigh | 7.742秒 | 未记录 | 上游拒绝前未形成token明细 | HTTP 422包装 |
| 热点总编 | gpt-5.6-sol / xhigh | 11.543秒 | 未记录 | 上游拒绝前未形成token明细 | HTTP 422包装 |
| 系列开拍独审 | gpt-5.6-sol / xhigh | 10.502秒 | 未记录 | 上游拒绝前未形成token明细 | HTTP 422包装 |
| GLM构思生成 | glm-5.3 / max | 117.901秒 | 117.901秒 | prompt 2,582；completion 8,498；reasoning 6,529 | completed |
| GLM构思独审 | glm-5.3 / max | 117.615秒 | 117.615秒 | prompt 5,092；completion 8,177；reasoning 7,471 | completed |
| GLM脚本 | glm-5.3 / max | 未持久化 | 未持久化 | 无outcome | Broker执行失败、durable accepted；Studio 42分59秒后本地失败 |

可确认的慢点有两类：GLM成功调用首个输出即接近118秒；GLM脚本异常没有可用终态，Studio又等待约43分钟才停止。OpenAI两次讨论携带约2.5万prompt tokens，其中备选等待45.5秒。没有同模型、同输入、同证据的改前/改后对照，因此不宣称提速或把全部等待归因给网络。UI把讨论、确认观察期与阶段累计混在“这一步用了这些时间”里，用户无法从页面复原上述事实。

## 已验证与未验证

已验证：正式dist和两个真实Broker启动；11类合同摘要一致；登录和主要导航；自有想法的导演初案、解释、备选、采用；一次OpenAI失败与一次GLM备选路由；热点刷新失败退化；系列创建和路线图持久化；声音设置界面；素材库空态；模板新增、编辑、刷新持久化和删除；390px与1440px主要页面；搜索焦点和Escape关闭；刷新后主run、系列和模板状态保留；全程控制台未见前端异常。

未验证：任何真实报价及三种预算动作；图片/视频购买与逐镜进度；TTS、真实听感、音轨和渲染；完整成片及逐帧检查；两个不同真实视觉模型基于同一证据的审片；审片建议预填和局部返工；缺证据负例的真实模型行为；热点正文成功阅读和真实总编发散；系列第二模型正链；两窗口版本冲突；Broker安全重启后恢复；有真实媒体时的素材按run展开、参考视频与本地交付下载。

## 建议下一批集中修复与最终现场

下一批不能继续按单个测试题补丁修。应按共同边界集中处理：

1. 先修真实主链：统一OpenAI结构化任务的CLI/Schema执行与安全错误摘要，至少用正式 `role-audit`、`topic-ideas` 两类canary证明；同时修GLM无远端任务身份时的accepted收敛合同。
2. 修状态与版本语义：预算字段单一合同、采用命令终态刷新、stage-scoped模型失效、失败阶段/角色/调用/耗时同一事实源。修完后先跑完整确定性状态序列，再启动一次有界真实主片，不再换题刷成功。
3. 修热点共享正文读取边界：DNS结果到IP安全校验的系统性错误必须用真实多域名正例和内网阻断负例共同验证。
4. 收口独立UX：声音预设变更摘要与Provider能力、模板暂停后的复盘定位、全局搜索“声音”应命中真正设置入口。

最终现场（2026-09-14 09:28 CST）：Studio `http://127.0.0.1:4317` 健康，PID 84675；OpenAI Broker PID 84673，`active=0, queued=0, completed=3, failed=3`；ZAI Broker PID 84674，`active=0, queued=0, completed=2, failed=1`。ZAI durable 原任务 `agent-e9fc...d60` 仍为accepted且无outcome，因此没有重启Broker。workspace保持 `workspace/qa-r11-20260914-001`。未commit、push、云部署、外部发布或修改产品源码。

最终QA状态：`QA_DONE_WITH_CONCERNS`。这里表示本轮可安全执行的测试与记录已经结束，不表示产品验收通过；真实主片仍被P0/P1问题阻断。
