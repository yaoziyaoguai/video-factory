# Revision 10 实施细则：模板退出与导演协作收口

任务：`VF-DIRECTOR-CLOSURE-20260914`。与同目录 TASK.md、PROMPTS_REVISION10.md、VALIDATION_REVISION10.md 配套。仓库根为 `/Users/jinkun.wang/work_space/veidofactory`；下述源码路径均相对仓库根。行号仅为 2026-09-14 的导航，修改前必须读取完整函数及调用方。

## 1. 结论、证据和边界

这不是重建项目。当前问题集中在三个交接边界：**要求进入角色的优先级、角色判断进入执行的可实现性、执行结果进入恢复与界面的真实性**。现有工作流、持久化和授权机制可以沿用，没有证据支持此时换框架。

已证实的情况（真实记录见 R9 QA 第 6–7 节）：

- 模板知识/证据职责压过用户的主观表达要求；纯生成示意被要求提交真实材料。
- 独立静态结尾被误认为必须延续同对象；真正需要跨镜统一的方案却在四条视频付费后才发现没有可靠机制。
- 保存新编剧模型后恢复，实际跳过编剧沿用旧模型成果；页面漏掉恢复后的 12 次成功调用。
- 两次 GLM 素材试片检查合计约 15 分钟；全量预检一轮 produce/audit 分别 504277/361073ms，queue=0、结构修复=0。已知时间在真实模型调用，不知道模型内部为何慢，不能写成网络根因已经查明。
- 真实素材完成、预检正确上推导演，实际媒体 ¥8.75。TTS、渲染、新成片、双真实成片审片和局部返工仍未验收。

已排除：OpenAI 快速 process_exit 源于 QA 启动时使用相对 workspace，改绝对路径恢复；18 秒返工源于只选镜头 1–4、正确保留镜头 5 的 3 秒。这两项不能再次当产品 bug 修；后者只加强范围提示。

## 2. 已固定的协作结构

```text
热点 / 系列 / 自有想法（保留三个独立入口）
                    │
         用户目标、明确限制、真实能力
                    │
  构思：前期导演统筹 → 编剧 → 视觉导演
       ↑            现有有界反馈       │
       └──── 问题指向真正责任角色 ──────┘
                    │
       已有独立审计 + 执行计划编译
                    │
         报价 / 用户确认 / 精确授权
                    │
       素材生成或复用 → 已有素材预检
                    │
        配音与声音处理 → 剪辑与渲染
                    │
      技术检查 + 双真实视觉审片 → 人工终审
```

图中的“前期导演统筹”就是现有 creative-treatment，不另建 Agent。视觉导演继续使用 director-plan；声音节点继续是实际配音执行者，不能只因名字叫“声音导演”就声称有一个会规划并混音的模型。

导演贯穿的是**意图与责任反馈**，不是每个节点结束后再调用一次导演。新职责落实在现有输入、产物、独立审计和 PlanningIssue 中，不加一套角色聊天总线。

## 3. S0：先接住模板停用半成品（V10-01）

允许范围按步骤约束如下；只改承担该行为的函数及其测试，不因某模块在表中就整文件重构。

| 步骤 | 主要允许模块 | 验收 |
| --- | --- | --- |
| S0–S1 | Studio入口/服务/模板展示；Pipeline有效brief与角色投影；Broker模板字段边界 | V10-01～05 |
| S2 | 三角色adapter、task-definitions/executor、creative-treatment/readiness、role-loop/checkpoint、creative-planning与阶段identity | V10-06～12 |
| S3 | production-capabilities、voice相关输入/validator、既有Python voiceover/renderer及声音配置展示 | V10-13～15 |
| S4 | Studio配置/进度/恢复展示、既有Pipeline/Broker恢复/trace和视觉请求组装 | V10-16～20 |
| S5 | 相关正式测试、合同摘要与构建验证、RESULT和必要用户文档 | V10-21、E10-01～09 |

当前未提交代码必须保留，不能从 HEAD 重做。主窗口先前已修改 NewRunDialog、ProductionStudio.start、StudioService、部分热点/系列入口及 TemplatesPage，尚未完整回归。

开工优先核对这些具体断点：

- `apps/studio/src/client/pages/TodayPage.tsx:28`、`components/TopicEntryWorkspace.tsx:32` 仍导入已删除的 `candidateTemplateUnavailable`。
- TodayPage 约 568 行仍从 selected.editorialDecision 写入 template。
- `apps/studio/src/server/production-studio.ts:8` 的旧 ProductionTemplateSnapshot import；`studio-service.test.ts:1627,1730` 等仍传已经移除的 resolveTemplateSnapshot option。
- `packages/production-pipeline/src/production-pipeline.ts:617` dispatch 及后续角色投影仍处理 templateSnapshot；三个适配器与 Broker directives 仍有 required 模板职责。

先运行编译/聚焦检查记录真实失败，再修悬空引用与新合同对应测试。不要为了保留旧测试恢复模板默认值。对改写的旧测试逐项记录“产品决定改变了什么”，不能 skip/xfail。

## 4. S1：模板退出全部新生产路径（V10-02～05）

### 4.1 唯一语义

1. 新 run、重新规划、新派生返工不读取、选择、要求或套用模板。模板目录为空、请求失败不影响三入口制作。
2. 模板库数据和 CRUD 保留。页面明确“模板暂不参与制作”，隐藏/禁用“用此模板制作”等生产动作。历史 run 可显示原模板快照为历史信息。
3. 新生产请求的旧 `template` / `templateSnapshot` 字段在 Studio **以及可独立调用的 Pipeline 新任务边界**剔除，不查询模板服务，不投影 templateGuidance。输入身份使用剔除后的有效 brief。返回/展示一次明确的“当前制作不使用模板”，不能假装已应用用户提交的模板。
4. 剥离仅限已知模板字段；其它未知字段和非法业务值仍严格拒绝。历史 parser 可保留读能力，不形成旧生产执行分支。
5. 自有输入、用户逐镜修改、已接受的系列 bible/canon、明确模型与声音设置保留。不能删除 entire brief、seriesContext、rework 或用户原文来去掉模板。
6. 不从旧模板 fieldSources 自动“抽取”隐藏约束到新制作。历史已确认方案中的实际镜头、素材、时间轴与付费授权仍是受保护事实，而不是模板条款；修改它们继续走原编辑/返工确认。

### 4.2 数据流清理范围

- UI：NewRunDialog、TodayPage、TopicEntryWorkspace、TemplatesPage；原模板预填的声音/素材模型不再重新注入。保留产品本身的合理声音默认值和用户已保存选择。
- 服务：ProductionStudio.start、assertReworkSource、StudioService、candidate-inbox-studio、editorial-decision、visual-source-compatibility。热点不再因推荐模板不存在而禁用制作，来源质量门保持。
- Pipeline：ProductionBrief 新执行规范化、screenwriterBrief、三个阶段 input identity、三个实际 port、initial/revision/audit/recovery 输入全部同义。不仅删首次 prompt。
- Broker：删除新任务输入中 templateGuidance/templateBlueprint 的角色使用和白名单；旧原物理请求只走既有 durable 查询，不将旧 payload 作为新 POST 再提交。删除 directives/outputRules/criteria 中落实模板 required 职责的要求。
- `planning-guidance.ts` 只有在本次消除最后正式调用方后才删除其孤立实现/导出；模板管理仍用到的 template-core 代码不删。不要清理不相关历史文件。

### 4.3 历史、在途和返工不能被一刀切

- 已完成历史记录只读，文件/账本/引用 SHA 不修改。
- accepted/unknown 原任务继续按原 requestId、route、binding 查询结清。新合同不能把“在途”改成“未受理”；不能为了模板退出重买素材。
- 旧产物结清后保存为原版本证据。若旧规划需在本轮继续生产，按现有阶段合同升级/失效机制在**下一次新执行前**复核；不把旧模板审计的 pass 当作新规则的证明，也不删原成果。
- 新返工仍验证 sourceRunId、expectedRunRevision、findings、previousScript、previousDirectorPlan、affectedScenePositions、source SHA 与付费未知状态。模板剥离不允许将局部返工扩大成全片。
- 镜头范围与文字时长要求冲突，预览明确“本次改哪些、保留哪些、预计总时长”。用户重新选范围才可扩大；不会从一句“改成20秒”推断授权修改所有镜头。

## 5. S2：共同依据、导演和审计（V10-06～12）

### 5.1 共同输入，不再另起一套事实源

复用已有字段：title/angle/audience、visualProof、visualIntent、durationRange、seriesContext、creativeTreatment、planningIssues、productionCapabilities、referenceGrammar、rework。不要新增“万能导演上下文”存储或把全部 run JSON 发给所有角色。

同一角色的 produce 与 audit 必须由同一有效输入投影构建，审计看到完整本轮用户限制、能力、范围和已接受上游产物。运行时状态/计数不进入创作 identity。特别检查 directorStageInputIdentity 与实际 director brief 是否同含 visualIntent；当前 identity 手工列字段，不能仅凭类型认为一致。

把同一投影用于阶段 identity 和端口，复用现有 helper；确需抽函数仅限这个实际重复边界。角色通用规则写在 PROMPTS 文档，不把整个资料包塞入模型上下文。

### 5.2 核心语义：机器不推测题材，独立审计纠正生产者分类

现有 CreativeTreatment v2 的 evidenceRequirements 继续使用，不换产物版本：

- factual_support：作品要观众相信的现实事实、因果、数字、实验结果、具体事件。
- illustration_only：明确的机制示意、情绪/艺术表达，不冒充真实事件。
- not_needed 指不需要事实举证，不是画面可以不生成；画面依旧必须有允许且真实存在的路线。
- pipeline_retrievable 仍只表示本项目已接线的通用图库检索，不把生成模型伪装成事实检索。

新增枚举本身不能证明语义正确。当前 `treatment-readiness.ts` 把模型填错的获取方式也当硬事实，`role-agent-loop.ts:469` 在 audit 后无条件优先 needs_source，导致审计即便发现误分类也不能修。必须改这个闭环，不能只再写一句“请正确理解”。

### 5.3 最小修订合同：保留宿主检查，允许明确纠正模型误分类

固定采用以下小扩展，不新增顶层 run 状态、不建立新审核角色：

1. `TreatmentReadiness` / `AgentLoopHostPlanningReadiness.status` 增加内部值 `revise_here`（仅候选待修）。沿用现有 issues、beat/source 身份。
2. `illustration_only + pipeline_retrievable` 选不存在/不允许/非图库 Provider，属于**候选路线错误**，生成指向 director 的 issue 和 revise_here；不是已证实用户缺专属材料。有真实缺料时 needs_source 优先，issues 保留全部。
3. critical external_required、critical supplied 缺绑定仍为 needs_source；factual_support 不得用图库/生成代证。sourceId 越界等结构错误仍由 parser 拒绝，不篡改候选。
4. 现有 `RoleAudit` 增加可空字段：

```ts
hostReadinessReview: null | { misclassifiedIssueIds: string[] }
```

仅 treatment audit 且 context 含 hostReadiness 时输出对象，其余任务输出 null。数组可为空、去重，Schema上限24（现有evidenceRequirements上限），运行时不得超过当前 host issues 数量，每个 id 必须存在于本轮宿主 issues。新合同要求显式字段；历史原审计只读保留，不能默认其已具有纠错证明。

5. 非空数组只允许 `verdict=repair`、`planningDisposition.action=revise_here`；对应 blocking issue 必须在 evidence 中指出**候选的哪项分类误读了哪条本轮用户要求**，repairInstruction 说明保留原核心承诺如何改分类/路线。不能因制作困难、缺钱或单纯分数高填写。机器验证字段/引用/状态组合，独立模型负责语义；代码不 regex 猜理由。
6. 宿主 needs_source 且任一 source/user 阻断未被该列表明确标为候选误分类：在第一次审计后立即按真实缺料/用户问题停住。不得为改文风再生成。
7. 全部 source/user 阻断被独立审计明确认定为候选误分类：只允许进入**当前已有轮次预算内**的候选修订，绝不直接改为 ready。新候选必须重新过 parser、hostReadiness 和独立审计。原用户事实承诺/禁令不能随修订消失；真实专属实验缺失的负例必须仍早停。
8. host revise_here + audit pass 不是可以开工：保存双方原始结论，以宿主的可修问题反馈到当前生产者，在现有预算内修候选。不要改写 audit 分数/verdict 伪装模型认同。可在已有 RoleRepairFeedback 承载宿主问题；必须保留来源身份，并让恢复得到相同反馈。
9. audit needs_source/needs_user 仍可停止，即使 host ready。只有 host ready 且 audit pass 才允许下一角色。质量循环耗尽走现有失败/人工修改，不新开循环洗预算。
10. hostReadiness、hostReadinessReview、产生的有效处置/反馈必须可由同 checkpoint 重放；新字段同步 parser、snapshot、AgentLoopTrace、RoleAgentPlanningHaltError、Broker Schema/validator。不能只改内存 if。原始 audit 与宿主判断分别展示，不能覆盖历史记录。

落点注意：当前构思 audit 的宿主值在 `context.upstreamFacts.hostReadiness`，不是顶层 context.hostReadiness。复用这个真实投影；audit 校验要取得同候选的宿主issues，不能只验证id是字符串。`creative-planning.ts:862` 的halt映射与 `production-studio.ts:2773` 的进度投影原先直接优先读 needs_source，须同步新的有效处置，修订中不能显示成已经要求用户补料。有效处置可从当前持久化候选+host+audit确定性重算，不另外建立状态表。

非核心来源缺失只可保留为未满足的补充建议，不能随后作为已证实事实写进成片。旧 standalone adapter 调用不因此取得越角色调度权；上述本地自动修订仅在既有规划模式内启用。

这取代 R9“宿主依据模型分类得出 needs_source 后，审计也不允许纠错”的规则；**不取代真实证据门**。验证必须同时覆盖误拦正例与真缺料负例，否则不算完成。

### 5.4 导演的全片可执行性与连续性

优先复用 `VisualBible`（motif、continuity、transitionGrammar、sound）和逐镜 continuityNote、referenceRequirements、successCriteria、reuseFromScenePosition、referenceFromScenePosition。不新增第二套分镜模型，不让普通 agent 自行扩出角色关系数据库。

付费前 director produce 和已有独立 audit 必须逐一说明：

- 哪些关系需要同一人物/物件/空间或真实连续变化；有哪些可执行的母片/源区间/已支持参考关系。
- 哪些只是全片色彩、构图、节奏的共同风格；可以独立生成，但生成提示必须真的落实视觉圣经，不能只写“电影感”。
- 哪些是有意独立的段落/结尾；独立不代表风格随意，也不等于必须对象完全相同。转场建议只有声明的剪辑能力支持才可采用，不能假设白闪、变速都存在。
- 若核心因果/对比依赖同对象，免责声明不能豁免；若叙事没有该依赖，不因出现相同关键词、否定句或两个 assetId 就强加连续性。
- `supportsReferenceImage` 不是全能能力：目前 referenceFromScenePosition 按现有 validator 仅用于它实际支持的交付。不能据这个布尔值擅开图生视频等未接线路线。

机器只硬验确切关系、Provider/交付匹配、覆盖、时间范围与越权；语义责任由独立审计判断。不加“出现连续/实验/手机等词必须拒绝”的规则。候选集成后仍走原全片校验，不因逐镜都合格省掉。

图库 no-match 的责任是当前获取路线未命中。先在用户允许池内走现有导演有界改案；若需新增购买仍重新报价。只有用户确需专属事实而当前确无材料才 needs_source；池内均不能满足则说明能力冲突、可调整的方式，不指控用户缺实验录像。

### 5.5 问题反馈责任

复用 `PlanningIssue.target=script|director|source|user` 及既有 finding.targetNodeIds/action：

| 实际问题 | 责任与最小动作 |
| --- | --- |
| 核心承诺/叙事或旁白不能兑现 | script；保留用户目标，调整文字/叙事；真改变目标才问用户 |
| 全片一致性无机制、时间覆盖/路线不可行 | director / replan_upstream；保留可用媒体与范围 |
| 方案可行，单次画面偏离 | assets / rework_asset；重新报价后才可购买 |
| 帧证据不足看不清 | inspect_existing_media；先取证，不重买 |
| 确需用户专属事实或超出允许方式 | source/user；明确缺项与可操作选择 |

不要把跨镜架构缺陷变成五次单镜碰运气；也不要把局部素材失败全量打回编剧。报告被审计通过和作品被批准是两个不同结论。

## 6. S3：声音与剪辑交接真实化（V10-13～15）

### 6.1 当前能力与固定改法

已读到的真实执行：`production-pipeline.ts:3120` 将 voiceDirection 的 voice/rate/pause_scale/mastering_preset 交给 worker；`voiceover.py` 实现 macOS/MiniMax/Kokoro 配音与 natural/intimate/social 声音处理；`renderer.py:775` 接 voiceover_plan.track_path，否则静音，没有独立音乐/SFX 混音链。

因此保留 soundPrinciples、sound_cue、visualBible.sound 的创作表达，但落实为可执行的旁白密度、停顿意图和已有声音处理；不承诺未接线的音乐、拟音或多轨。风格预设中的音乐/环境声建议只是参考，不是已支持能力；它们不能覆盖用户声音选择或成为审计硬门。

只增加一份窄的能力输入，不新增声音产物系统：

```ts
// 加到现有 ProductionCapabilities；由宿主实际配置生成，非用户自报。
audio: {
  narration: boolean;
  pauseControl: 'punctuation' | 'text_hint' | 'unsupported';
  musicTrack: boolean;
  soundEffectsTrack: boolean;
}
// 仅编剧/导演 brief 用于自然时长安排；从既有 voiceDirection 投影。
voiceTiming: { rate: number; pauseScale: number }
```

- 当前生产路径如实发送 audio。macOS 为 punctuation，MiniMax 为 text_hint，Kokoro 现有调用未消费 pause_scale 则为 unsupported；musicTrack/soundEffectsTrack 当前 false。能力未知不默认 true，离线替身只在测试。
- `rate` 不是统一精确字/秒：MiniMax 当前按 rate/190 映射 speed；不能根据数字保证精确音频长度。pauseScale 不是跨 Provider 的精确毫秒承诺。
- 前期构思收到稳定 audio 能力，编剧/导演及审计另收到 voiceTiming。voice profileId/masteringPreset 仍在执行配置/receipt，不因换音色强迫前期构思重跑。实际不支持的参数保留用户配置但界面明确“不由当前配音服务执行”，不能展示成已生效效果。
- 新输入同步三个适配器、Broker normalizer/Schema、audit context 和实际读取它们的 stage identity；audio 能力改变才影响其消费者，voiceTiming 改变影响编剧/导演及后续，单纯音色/声音处理变化只失效声音及下游。无效输入照现有 rate/pause 边界拒绝。
- 不添加声音模型调用；不因可选音效暂不支持就阻断一部不依赖它的片。若用户核心效果确实必须依赖该音效/音乐，明确能力冲突，不能默默删要求；纯粹模型自拟的不可执行建议在当前角色内修订。

### 6.2 时间轴与声音失败

`validateVoiceNodeInput` 当前返回白名单不包含 executablePlanPath，而 getInput 传入了它。这是明确的传递风险，先写正式 worker 路径测试判断有效参数是否真的被丢弃；若丢失，按已有路径校验保留它，禁止只改测试替身。

配音按已接受 executable plan 的逐场时间而非旧目标秒数；实际语音过长保留已有 `VOICE_DOES_NOT_FIT` 和 raw audio SHA，不能截尾、强制加速或改总片长掩盖。沿用既有调整旁白/时长流程，未受影响媒体仍绑定复用；涉及扩展母片或新购买重新报价。

剪辑只执行当前正式计划；源音轨、配音与最终音轨如何使用必须如实展示。声音提示未产生音轨不能称已完成。双视觉模型仅收图像时不能验听感；真实 QA 要播放音频并验人声/节奏/同步，不能用视觉 pass 替代听觉证据。

## 7. S4：恢复、统计、耗时和文案（V10-16～20）

### 7.1 模型与恢复

触点：PlanningStagesPanel、NodeWorkspace、ProductionStudio.applyNodeExecutionConfiguration、pipeline 的 stage identity/跨 thread 播种、role-agent-loop/checkpoint/client。

- 保存后的生效选择与下一次实际路由一致；下拉草稿未保存不允许“重试”误用。失败保存继续 reject，冲突保留草稿但要求重新确认当前 revision。
- 换编剧模型，构思可继承，编剧及后续必须失效；换导演只影响导演及后续。不能因文件存在或角色名相同命中旧 checkpoint。
- 在途原请求不切模型；结果未知只观察原任务。明确未受理与已失败按现有有界恢复，不能全类错误触发 backup。检索成功的原结果只消费一次，暂停不自动解除。
- 查询期间原任务正常完成返回最新有效 run，不误报 409；真实输入/请求身份冲突仍拒绝。重启保留确定失败原因与完成阶段，不把一切改“应用重启中断”。

### 7.2 统计与进行中进度

`production-studio.ts:2690 loadAgentLoopProgress` 为入口，沿既有 receipt/checkpoint/planning-history 核对：

- 按物理 requestId + 原 operation/role/stage 身份去重，汇总 treatment/script/director/rank/试片/预检/终审中实际调用。不能取最后一个 trace，不能累加同一计数器快照。
- 总调用=有执行证据的 producer+audit；结构修复为其中子集。查询/页面刷新为零新增。缺执行证据是 unknown，不是0或猜1。
- 分清当前轮、同 run 历史累计、跨 run 继承。展示实际执行模型与将使用模型，不覆盖历史身份。
- 进行中也消费已落盘的逐镜完成/费用事实，不能一直等待外层节点完成才更新。已确认、在途、未知、授权上限分别显示；不重建核账平台。
- 阶段0/3若非真实状态应改成真实完成阶段/处理中；失败或暂停仍保留已完成项目和当前正在等谁。

### 7.3 慢的问题：先解释实际时间，再做无损精简

复用已有时序 trace，分别报告排队、提交/启动、媒体准备/图像预处理、模型等待、结构修复、观察等待、本地校验/合成。区间有重叠不能相加；缺数据写未细分，不用 mtime 做精确 Provider 用时。

检查视觉 producer/audit payload：同一脚本/导演方案/历史报告是否重复嵌套；图片是否通过原生 images 发送后又在 JSON 文本内重复 base64；审计是否不必要带全部旧轮候选。只删除**重复信息**、不用全历史替代当前候选+必要修订，保持当前证据帧集合、映射、SHA、实际图片内容、模型、effort、上限、评分阈值与独立性不变。不另建跨 run 视觉审计缓存，不跨模型共享结论。

如果证据表明没有重复，不能凭猜测删上下文。记录耗时仍属模型端、保留现有 deadline/原任务观察机制与诚实进度，不声称已提速。不得增加无界等待，也不凭空缩短现有20分钟 Provider 执行边界。接受等待变超时不等于任务没运行；继续保护 unknown 任务。

### 7.4 用户文案

首页/制作/返工相关区域用“问题是什么、系统做过什么、你可怎么继续”三段简明信息，技术日志折叠保留。建议固定表达：

- 缺真实材料：“这部分需要你提供的真实记录，当前素材库和生成画面不能证明它。可补充材料，或调整要表达的结论。”必须列具体缺项。
- 普通素材未找到：“已找到的画面不能满足这一镜。可以调整画面方案或允许其它制作方式。”不写缺实验记录。
- 在途：“原模型任务仍在处理，查询不会重新生成。”不写“未扣费，点击解锁”掩盖未知。
- 上游返工：“这几镜需要先统一画面方案；已有素材会保留，新增制作会重新报价。”列影响范围。
- 模板库：“模板暂不参与制作；已保存模板和历史记录保留。”

保留原主流程、技能/模型下拉、声音自动执行等已有交互，不把本轮变成删功能。无障碍与390px布局随改动回归。

## 8. 协议一致性是贯穿项（V10-21）

每新增/删除角色字段都走同一条链：Studio parse → ProductionBrief → 实际 port → Broker require* normalizer/白名单 → 输出Schema/语义validator → pipeline validator → checkpoint恢复 → audit context → identity/digest。

重点文件：`apps/codex-broker/src/task-definitions.ts`、`codex-executor.ts`（requireDirectorBrief、requireTreatmentBrief、requireScriptBrief、requireProductionCapabilities 及 audit 输出校验），pipeline 的 `codex-chat.ts`、三个角色 adapter、creative-treatment、role-agent-loop/checkpoint 和 production-capabilities。

COMMON_ROLE_PREAMBLE 属于 descriptor 的公共输入。改它后必须重新计算并核对**全部10类**任务摘要，包括 OpenAI/ZAI health 与 REQUIRED_CODEX_TASK_CONTRACT_DIGESTS，不能只更新眼前3个任务。不要抄 R9 日志里的旧 SHA。source/dist 和正式组合必须同过。

不为维持测试伪造 digest 相等、不关闭探针、不放开未知字段。无任务环境才能部署最终 build；已接受旧任务按原合同结清，不重 POST。

## 9. S5 与交付

严格执行 VALIDATION_REVISION10.md。先聚焦红绿，再集中回归；最后本地生产构建的一轮有界真实 QA（需当前授权），不边测边改。

RESULT 逐 S、逐 V10/E10 追加修改、证据、退出码、未验证和费用。补齐受影响 README/架构说明中的模板暂停与声音真实能力，不重写整个文档库，不改旧 QA 事实。代码修改后可按现有 Graphify 规范一次 update；失败单独记录，不为修图谱拖住产品主线。

所有范围内代码与获授权验证完成后停止。真实 QA 未获授权、长耗时改善未证实或没有完整成片，要明确写出，不能以全量测试绿色替代产品验收。
