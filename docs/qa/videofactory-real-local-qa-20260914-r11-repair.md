# R11集中修复后的真实本地QA

状态：QA_DONE_WITH_CONCERNS / PRODUCT_NOT_ACCEPTED / CHANGES_REQUIRED。集中修复、回归、正式本地部署和有界真实复验已结束；范围内仍有失败与后半程缺口，不是全部11项验收通过。实现提交审查状态为READY_FOR_REVIEW，不自批ACCEPTED。

- 仓库HEAD：b36ebac3189cf574b8e437cbe16eb9d0b228a177，保留未提交修改，不commit/push。
- 计划URL：http://127.0.0.1:4319；workspace：`workspace/qa-r11-repair-20260914`；runtime：`.local/runtime/qa-r11-repair-20260914`。
- 使用QA与browse技能，按任务覆盖技能的clean-tree/commit/逐bug修复/遥测默认行为。真实浏览器操作与只读日志诊断分开记录。
- 模型计划：OpenAI gpt-5.6-sol/xhigh，ZAI glm-5.3/max，最终以实际receipt为准。新dist的正式Broker，不使用fake。
- 沿用本轮累计50元授权，启动前旧R11现金0、未知现金0；旧未知GLM请求保持原样，不重投。

## 固定主片目标

做一支20–35秒的竖屏短片，面向忙碌的城市上班族，表现人从匆忙到注意到日常小变化的过程。开头有吸引点，结尾有具体的情绪兑现，配少量自然中文旁白。画面可使用生成示意，不声称是新闻现场或真实实验。全片风格统一，不要默认模板、不要用说明卡替代画面；镜数由叙事决定。预算意向35元，不等于付款。

## 代码检查

完整日志在`videofactory-real-local-qa-20260914-r11-repair-assets/checks/`。首轮通过：TS814/0/1skip，Studio组件395/395、Node531/531，Broker202/202，Python131/131，typecheck/build/package3/3、R6 source/dist各15/15、R9各5/5、R11各4/4。集中补修后：TS815/0/1skip、Broker205/205、Studio395+531、typecheck/build/package3/3；最后补审计拒绝的phase计数测试后，role-loop37/37、组合295/295、正式build、R11 source/dist各4/4通过，没有再声称完整TS已经跑到816。保留首轮脚本并发造成的dist竞争失败日志及串行成功日志。所有“通过”检查均已有退出码0，既有skip未算通过；完整build只有既有大chunk警告。

## 实际QA覆盖

| 用例 | 状态 | 证据/缺口 |
|---|---|---|
| Q11-01 正式环境 | PASS | 新dist，4319，真实双Broker，正式登录与合同检查 |
| Q11-02 三阶段讨论确认 | PARTIAL/FAIL | 导演讨论/采用/确认、脚本修改/撤销/确认完成；分镜唯一复验duplicate_scene_position阻断；撤销指令补修仅有确定性复验证据 |
| Q11-03 报价三动作 | NOT_VERIFIED | 未到达 |
| Q11-04 媒体/TTS/成片 | NOT_VERIFIED | 未到达 |
| Q11-05 双真实模型审片与局部返工 | NOT_VERIFIED | 未到达 |
| Q11-06 热点正文 | PARTIAL/FAIL | 6 read/2 title_only，澎湃原文段落核对，真实总编与独审成功返回；最终6ideas被宿主过滤成0，未能采用进入制作 |
| Q11-07 系列/第二模型 | PARTIAL/FAIL | GLM-5.3/max初案/讨论/脚本及确认通过；3次分镜成功，图库候选仍不足，21m14s后停在needs_source，未到报价 |
| Q11-08 缺来源负例 | PASS | 原run修后恢复，GLM初案成功；真实独审76分明确缺本人实验材料，保持treatment等待、script未开始、媒体0 |
| Q11-09 配置声音路线 | PARTIAL | 预设保留演员、搜索声音/停顿可达；实际TTS/配置失效未验证 |
| Q11-10 刷新/双窗/重启 | PARTIAL | 同workspace安全重启、当前稿/阶段保留；真实下游模型保存后上游SHA/check未回退；390未发送草稿刷新保留；双窗冲突未做真实复验 |
| Q11-11 桌面/移动可用性 | PARTIAL/FAIL | 声音/复盘/素材空态/模板CRUD已点；390无横滚但底部动作遮挡发送；付款/成片/交付未达 |
| Q11-12 调用/时间/费用 | FAIL | 正常未知警告消除、拒绝恢复能推进；恢复checkpoint累计被误标本次，费用摘要口径也不一致；现金0 |

## 问题与过程

11:15浏览器经自有想法→保存机会→新建制作，输入预算35、范围20–35秒并允许生成画面，成功创建`run-25b4c195-a50c-4344-98fd-197d1bf58438`，正式run.json保留预算35和范围，未再400。OpenAI开始构思，尚未确认、未产生媒体。截图02-create-budget。

### QA-R11R-01：正常执行中提前显示未知恢复警告（已记录，未边测边改）

- 严重程度：P2；属于F04状态表达遗漏。
- 证据：`screenshots/03-live-progress.png`；主片约30–50秒，Broker active=1/queued=0，Studio run正常running、无失败，却显示“暂时无法确认…请先查询原任务”；同页“策划定稿1/1”已勾选，而导演尚在生成。
- 源码依据：`withTaskRecovery`只要存在pending checkpoint、无receipt就按accepted_unknown呈现，未区分正常running。`beforeSubmit`快照不等于执行失败。
- 影响：用户可能误以为模型已经出故障；未观察到重复提交或状态损失。主片继续正常观察，不点击重试。后续可测项继续。

工具环境记录：短生命周期命令使browse会话重启，第一次填登录未提交；改用持续shell会话后正常登录。第一次入口被自动新手引导遮挡，正常关闭引导后继续。均未调用额外模型。

主片已完成真实导演初案（OpenAI 91.843s）、解释（18.321s）、独立备选（75.918s）和采用。采用后当前稿更新、确认按钮可用，无需刷新解锁，仍等待确认；采用自身0模型调用。三次真实调用均gpt-5.6-sol/xhigh、排队0。截图05-adopted。已点击本版确认，开始真实role-audit，尚未得出结果。

声音搜索从Resources同页成功进入#voice-casting；点击人物纪实后Tingting仍被选中，节奏改170/1.2/intimate，未将演员换为Meijia。截图04-voice-preset。此处只验证编辑，未将这项未保存设置当成主片音轨。

### QA-R11R-02：自动建议与界面“必须看到”表达仍有混淆（待核实强制影响）

- 主片未填写“必须看到的证据/视觉论证”，initialInput仍带自动visualPlan（图库人物/同期声），页面将它拼成“必须看到人物、街区细节与同期环境声”。用户只要求自然旁白、允许生成示意。当前导演主动说明无同期声混音时用旁白停顿替代，因此尚未证明它实际强制阻断。
- 确认事实：界面与用户真实输入不一致；不能据这一段文案断言架构已经回退。继续观察真实确认与下游消费，若阻断保留审计原文。
- 系列新建使用默认六集题目“真实任务实验/验证”等，与本轮城市观察承诺不符；已用正常编辑路线图入口设置第一集为晨光观察，记录这是QA人工策划，不是模型生成的高质量路线图。

## 费用

主片后续：导演独审95分pass，脚本produce 174.683s成功。第5段旁白修改成功（attempt-6），撤销恢复原稿（attempt-7），界面无需刷新可确认。首次脚本独审提出“前6秒尚无部分画面兑现”，未报接口错误。按建议发出一次开场调整时，讨论模型仍把已撤销修改的“其余不变”当作有效范围，要求再次确认。已明确授权取代旧范围，未重复确认同一失败稿。

### QA-R11R-03：撤销后旧局部限制仍影响新讨论（待核对指令投影）

- Q11-02：稿件撤销有效，但下一次讨论输出仍称“已生效的要求是仅修改第5段”。可能是有效指令未撤销或历史消息优先级歧义，需结合review状态和实际prompt核对；不能只按模型解释认定存储损坏。
- 实际影响：需要额外解释一次新范围，增加29.306s讨论，无现金；未丢原稿/绕确认。明确新旧要求替代后继续观察。

系列`run-62324471-a9bd-4e6d-9b90-5cfe049dc700`：实际GLM-5.3/max初案116.813s成功，方案保留暖灰视觉/不固定人物身份/AI示意/不做健康承诺，正在做只解释的连续性讨论。此时未确认/未购买。

模板：新建本轮QA-R11R-临时模板→编辑适用说明→保存→刷新确认持久化→只删除该QA模板并确认消失，6个内置模板保持。删除的是临时测试记录，不是用户历史模板；测试文本保留在本报告，未验证恢复删除功能。

热点：进入页面自动启动首次真实采集/总编流程，尚未返回，没有重复点击刷新。

### QA-R11R-04：队列满被误报为会话连续拒绝（已核实）

- 负例run `run-6083f24f-bc98-4fb5-81f2-2aeb3954e285`在主片讨论和热点任务占满OpenAI active=1/queued=1时启动。7.8秒内以“会话被连续拒绝2次”失败，实际模型0，未真正测试到缺来源语义。
- 三条原request（`agent-1d0f97...`、`agent-7b0291...`、`agent-d553b6...`）durable均为`not_accepted`，outcome明确503 `Codex broker backlog is full.`。重读已拒任务被转换409/not_accepted，再被loop错误归为session重建，掩盖队列原由。
- 属F03/F04安全诊断与失败投影遗漏；不修改并发配置或抹记录。待本轮队列空闲后只允许一次有环境变化依据的同run复验；不把这次失败当缺来源负例通过。

QA-R11R-03补证：正式`creative-discussion-c9c5ca...` trace.prompt的effectiveUserInstructions确实仍含已撤销旁白修改指令；`creative-review.ts`撤销分支只交换draft/document，没有同步有效指令，已确认存储/输入投影原因。

主片后续有效修改已返回：`creative-discussion-6fa862...`实际模型70.183s，队列331.112s（不是同一请求运行6分钟），修改场2在第6秒前显露树影，保留其余范围；已提交一次本版脚本复验。热点`agent-7d5c874...`真实topic-ideas成功，模型406.002s、排队0；后续热点role-audit仍进行。说明共享单并发队列的长热点任务实际延迟主片操作，没有擅自调大并发或降模型。

正文8个URL：6 read、2 title_only，无Invalid IP错误。已在独立浏览器打开澎湃原文`https://www.thepaper.cn/newsDetail_forward_34060480`，核对标题、首段与纪念演出的段落相符；缓存中有对应paragraph IDs/contentSha。B站read只读到描述/元数据，不把“read”当已观看视频或证实烹饪效果；后续来源审查仍需判断正文证据是否充足。

系列：真实GLM解释39.032s成功；导演确认独审通过并生成脚本，已提交脚本确认。截图07-series-status显示正式脚本等待确认；本轮没有媒体任务。

### QA-R11R-05：分镜语义校验失败，具体规则被安全投影丢弃（P1，F03遗漏）

- 主片脚本复验96分pass后，分镜request `agent-c389b3c2b13326bdd798798bb58e58d8e6be68ea922984063080d2280d6253ec`完成为failed：`invalid_output/task_semantics`，模型234.566s、排队20.333s。Broker outcome只有“The model could not complete this step.”，不是网络超时，也不是上游HTTP422。
- `codex-executor.ts`知道semanticError却只传task_semantics通用code；任务临时输出在finally清理，durable未保留规则位置。当前证据不能区分重复scenePosition、reference/reuse冲突或非法reference路线，不编造根因。
- 当前主片未到分镜讨论/报价/素材；没有点击原输入重试。应把可信校验器的规则类别/字段位置以安全白名单保留并贯穿，而不是暴露任意模型文本/本机路径。修复诊断后允许一次原run受控复验；仍失败则保存具体原因收口。

系列脚本独审提出1项阻断（结尾5秒不足以容纳旁白及留白）和2项建议（开头余量/墙面连续性）；已通过讨论一次性修改为27秒并补连续性判据，未降低内容质量或事实边界。

R11累计已花¥0.00，在途/未知现金暴露¥0.00，授权余额¥50.00。媒体、TTS、成片和双审均未发生。

## 集中补修与唯一受控复验

已集中补修QA-R11R-01～05，未边点击边修改。代码与完整回归日志见RESULT“补修验证完成”及checks/qa-followup-*。新dist三服务12:23启动，同workspace、同socket，原稿与已确认上游保留。

### QA-R11R-05复验：已定位规则，但生产链仍阻断（P1）

12:27在原主片只点击一次“重试失败步骤”。新director-plan `agent-c1381e9b8b425cd092ea96333ba30c4be665b388a5519c930bc7aac3d2373915`执行183185ms、排队0，以Broker422结束。安全诊断明确`invalid_output / duplicate_scene_position / output.shots[2].scenePosition`，即第三个shot重复使用已有scenePosition。诊断已贯穿durable、client、run.nodeRuns.error和刷新后的导演阶段面板，不再当成网络问题。旧request的task_semantics具体规则仍无法逆推，不断言两次都是同一个编号。

- 真实脚本有5个position；现有导演合同要求完整制作每个脚本scene恰好一次。模型为什么输出重复，是对脚本内切换拆分的理解还是其他生成失误，临时输出未保留，尚不能确定。不能由QA给它删镜头/重编号、改脚本或关校验过关。
- 这次仅director-plan有新增执行，未重跑已确认treatment/script，未购买任何媒体。原run revision11、failed，12个此前创作产物保留，新增失败trace不等于分镜成品。
- 已完成条件变化后的单次复验，不再新建run/换模型/重复同输入碰碰运气。分镜讨论、报价、媒体、TTS、成片、双真实模型成片审片、局部返工均仍未验证。
- 截图11为补修后正常running状态（不再未知警告），12为终态失败。刷新前阶段详情短暂缺失，刷新后可看到具体诊断；不能把只在日志可取与页面当时已显示混为一谈。

### QA-R11R-06：恢复后的本次统计仍混入历史（P2，F04未完全修复）

主片本次只新增上述1个director请求，UI却显示本次2次、内容生成累计7分19秒，步骤总耗时3分4秒。checkpoint恢复沿用旧请求与累计phaseDurationsMs，并将recoveryOwner改成新workflow operation；`summarizeJointPlanningExecution`按整个checkpoint的当前owner划分本次/历史，无法把其内部旧执行分开。即使重复文件去重，仍会把同一checkpoint中的前一轮划到本次。系列费用摘要还显示5次执行，而阶段本次12+此前6，说明各摘要口径尚不一致。

最小待修是让物理request的归属与时间证据参与本次/历史划分，保留现有持久化和旧证据，不新建核账平台。应以“失败一次→新operation显式恢复→一次新请求→刷新/重启”回归；不能仅改页面数字或把历史清零。本段不继续第二轮产品修改。

### QA-R11R-07：示意作品图库无匹配仍进补实拍死路（P1）

系列run在03:52:06Z至04:13:19Z间运行21分13.735秒，GLM三次director-plan全部成功，初始生成1/2/3、图库4、复用5；调整后改为图库1/2、生成3/4、复用5。图库1/2仍达不到语义阈值，最后在needs_source有界停止。checkpoint与candidate-search/attempt-1～3保留，截图10。

确认的缺陷是当前页面针对这个AI示意目标仍主要建议“上传或实拍”“改为不主张实验事实”，未提供已允许生成路线的明确处理入口；没有证据证明所有候选都应该自动采用，也不能把图库不足当网络错误。源码已有illustrative路线调整权，不能重复新建另一套。下一步应核对no-match反馈是否确切进入下轮导演、为何调整把另两镜转回图库，以及失败后用户能否回到当前分镜讨论。系列正链不是PASS，不购买第二主片。

### QA-R11R-08：热点模型成功，但合法创作表达被词面过滤（P1）

本轮总编有真实最终6ideas，引用sourceId/paragraphId均对应当前已读正文；使用正式TrendOpportunityAgent与原模型输出、原signals/articleSources离线重放，最终0 candidates。源码`groundModelIdea`对hook/rationale/画面描述调用`unsupportedClaim`，把引号中的创作标签与来源逐字匹配；“网红厨具实测”“角色如何被交接”“原话—转述—推演”等不在原文即可能拒绝，此外还含固定归因词/英文/数字过滤。

这不是正文DNS故障复发，也不是模型未返回。具体每个字段触发哪条规则尚未生成逐字段诊断，不能断言全部只由引号造成。需区分可追溯事实引用的机器校验与已存在独审的事实语义判断，保留真实缺证拦截，不简单删光来源安全。已完成一次真实刷新，不反复更换新闻测试。热点采用到导演仍未验证。

### 负例修后恢复（进行中）

12:31队列空闲后仅恢复原负例run；旧队列拒绝记录未清除，新真实GLM构思`agent-afd78f1e29f2b12d2baf6816e67937c2609855e6f3c0b789f7b4f4aae1ea7556`成功（glm-5.3/max，69283ms）。原run进入导演讨论等待，没有再秒败。页面仍将之前失败尝试混入本次2调用统计，属于QA-R11R-06。

初案明确本人两次真实录像与计时未提供、禁止伪造。一次确认后真实独审76分repair，明确四项兑现缺当前无法取得的本人录像/数据，停在treatment waiting_user、script未开始、媒体0。审计request `agent-38f1c6dac7d01f942217708a60f4624ad673c35fea8fb77539272061a3cf0399`为OpenAI gpt-5.6-sol/xhigh，27940ms；GLM负责本次初稿，不能误称此独审也使用GLM。截图14。

随后在同负例只把脚本模型由sol改为GLM，保存→按人工版本继续→刷新：run revision3→5，treatment草稿SHA始终`ca743be661b34c403cb40b01227335821d6d4adafeb96b84532ead8bcae82fe1`，reviewRevision2，check仍repair76，没有伪造pass，没有新增模型任务。证明该真实失败检查场景下下游模型变更保留上游；不代替主片“采用备选后切模型”的全部并发矩阵。保存失效期间creative-review GET有一次404，UI后来恢复，console已留证；无JS异常，不写console全程零错误。

### QA-R11R-09：390手机讨论发送被底部动作遮挡（P2）

真实390×844切到“讨论”，填两行未发送草稿并刷新，文本保留且scrollWidth=390，但发送按钮中心被sticky的“撤销本轮修改”覆盖。截图15，DOM命中证据：发送rect x36/y718.297/w83/h42；底部撤销rect x17/y730/w166/h42；发送中心elementFromPoint返回“撤销本轮修改”。未为测试点击遮挡区域误发模型请求。

`studio-v3.css:1235`的creative-review-actions采用sticky/bottom72/z-index2，但内容底部空间与独立发送动作未协调。需要调整移动布局/内容安全区，验证390窗口与长输入/软键盘/滚动；仅无横滚不能算手机可用性通过。属于真实QA新发现，未继续下一轮产品修改。

## 本次代码验收矩阵（不以总测试数代替具体证据）

PASS指所列确定性行为已验证，不等于全产品真实通过。PARTIAL明确保留资料包全量序列中的缺口。

| ID | 状态 | 证据与限制 |
|---|---|---|
| V01 | PASS | budget合同/解析回归、正式创建35元往返且零授权；UI非法值/边界由contracts及组件覆盖 |
| V02 | PARTIAL | RunPage终态观察组件、正式命令持久化及真实采用恢复通过；generic retry终态仍有阶段详情需刷新补全现象 |
| V03 | PASS | 两executor诊断白名单/脱敏、durable/client/loop测试及真实duplicate_scene_position到run和页面；旧历史不可逆推 |
| V04 | PARTIAL | 正式三gate图/HTTP/socket与source-dist回归通过，真实treatment/script确认推进；缺真实director确认消费证据 |
| V05 | FAIL | 正常运行/当前stage部分修复，真实恢复仍将同checkpoint旧调用计为本次，QA-R11R-06 |
| V06 | PASS | 正式carry/recovery组合测试，真实失败检查后仅改script模型保留上游SHA和repair76；未宣称真实并发所有分支 |
| V07 | PARTIAL | 未知换模型/输入持锁、beforeSubmit陈旧快照回归通过；真实双窗冲突、声音节奏变更完整链未验证 |
| V08 | PARTIAL | 正式规划/授权/复用等回归通过；新补修未把全部原始浏览器失败序列合并为一条完整真实主链，报价后仍未到达 |
| V09 | PASS | 正式入口、串行回归、build/package/source-dist及43文件源码摘要差异已保存；无隐藏失败计PASS |
| V10 | PARTIAL | uncertain诊断保存、有界观察及恢复/未知锁回归通过；没有人为切断真实Provider复验；旧无诊断accepted仍未知且保留 |
| V11 | PARTIAL | 11类schema/实际executor参数回归、真实topic与role-audit不再schema拒绝；热点宿主后过滤与director语义拒绝仍阻断业务 |
| V12 | PASS | 正式lookup callback、all形状/IPv4/IPv6及安全网络回归；真实6篇read和澎湃段落核对，无InvalidIP；不声称看过B站视频 |
| V13 | PARTIAL | 多演员×节奏预设、不可用演员、Provider能力说明回归及真实预设保留演员通过；未执行最终TTS/听音 |
| V14 | PASS | 作品优先、模板历史/无样本/接口失败回归及复盘空态真实检查；模板CRUD保留 |
| V15 | PASS | 声音/配音/音色/语速/停顿索引与同页hash回归；真实声音/停顿点击到分区，无模型调用 |

## F01–F11最终逐项结论

| 问题 | 结论 | 实际实现与仍需注意 |
|---|---|---|
| F01 | 修复并真实复验通过 | ProductionBrief/parser/预算输入/角色上下文，35元成功创建，非付款 |
| F02 | 原采用问题真实通过，仍有相邻遗漏 | RunPage等待原命令终态并刷新review；generic retry后阶段详情刷新问题未完全消除 |
| F03 | 原独审schema问题通过，整体部分完成 | provider schema转换且领域限制保留、安全诊断贯穿；新分镜重复编号仍阻断 |
| F04 | 未完全修复 | run/workflow/阶段投影与去重已修改；恢复内旧请求归属和费用卡片口径仍错误 |
| F05 | 修复并有真实保留证据 | 同run工作稿与确认资格分开，模型保存只失效实际消费者；全部并发组合不冒称实测 |
| F06 | 代码修复，真实未知恢复未验证 | ZAI同步执行结束的未知诊断持久化、有界观察；旧accepted不能凭补丁变成已知失败 |
| F07 | 共享调用故障通过，入口正链未通过 | topic/role-audit真实成功；热点宿主过滤与系列图库选择另有问题 |
| F08 | 修复并真实复验通过 | Node固定IP callback合同、安全保护不变，正文实际读取核对 |
| F09 | 预设/说明修复通过，真实音轨未验证 | VoiceStudio不暗换演员/路由，不可用演员不默认替换；TTS后半程未到达 |
| F10 | 修复并真实复验通过 | 复盘以作品为主、模板仅历史，不删CRUD |
| F11 | 修复并真实复验通过 | 原索引补声音入口，Resources同页hash激活 |

改动以原资料BASELINE的321项文件摘要对比，43项发生变化；完整列表及前后SHA在`-assets/final-evidence.json`。修改集中在Broker/client/loop、planning/creative-review、Studio状态/声音/正文/搜索及对应测试，原dirty成果保留。TASK/REVIEW未由本执行修改；没有新框架/数据库/平行生产路径。

## 费用、调用与交付缺口

- 本补修QA目录41个durable request：38 completed（36成功、2分镜失败），3 not_accepted（队列拒绝，未执行）；没有accepted在途。数字是物理Broker任务，不把轮询/采用/撤销计模型；内部结构修复若无独立receipt不能额外凭空计数。每项实际模型/effort/耗时/输出SHA/原durable路径在final-evidence.json。
- 原R11此前9个物理任务单列保留；本轮总止损不重新计算起点。旧GLM `agent-e9fc146b...`依然accepted无outcome，结果未知，不重投。该任务按现有订阅路由无新增按量现金，不能由此声称执行已失败。
- 4条R11相关run均无spendAuthorization；所有receipt仅subscription/local_compute，媒体/TTS节点从未启动。已确定现金¥0.00，在途/未知现金暴露¥0.00，累计授权余量¥50.00。没有打开Provider收费任务，未通过账本0去推断一个已提交付费请求免费。
- **新成片、正式音轨、两个真实视觉模型对同片/SHA的报告、局部返工媒体复用与新片、交付包：全部不存在/未验证。** 订阅文本独审成功不等于成片双审成功；未听音，听感未验证。不能产品放行。
- QA参考健康分不用于本轮产品结论：核心流程被阻断，且部分页面不可达，给全站高分会误导。上述逐项矩阵与阻断证据为验收依据。

## 交回审查

代码检查为CODE_VALIDATED（仅指已列命令通过）；真实QA为QA_DONE_WITH_CONCERNS；产品为PRODUCT_NOT_ACCEPTED，建议CHANGES_REQUIRED。按MASTER的有界策略，集中补修后原链单次复验仍失败，停止新生产与产品修改，保留可调查现场。不是等待额外付款权限，也不继续用新题目或不同模型刷成功。

后续应优先收敛分镜输出合同的有界修正/合法保留、图库无匹配返回分镜讨论的可操作路径；并修热点事实/创作表达混判和按请求归属统计，再处理手机底栏。不要把这些解释成需要重写整个工作流，也不要仅针对本片编号打补丁。修复前已有待查项与不确定性已分别标出。

最终环境保持运行：Studio http://127.0.0.1:4319，PID86968；OpenAI PID86965，ZAI PID86967；两个Broker active/queued均0/0，正式Node26.8.1，workspace与socket不变。完整构建SHA在final-evidence.json。已观察的console异常仅模型保存失效期间一次creative-review 404，不能泛称所有页面无错误；未覆盖页面也不计健康PASS。

TS唯一skip为`e2e.real.test.ts`的`renders and approves an audible 1080x1920 production package`，按既有`VIDEO_FACTORY_E2E !== '1'`跳过；没有把该旧入口当本次三阶段浏览器E2E。它不是已通过的成片证据。本轮只读证据汇总脚本曾有一次括号语法错误，修正后完成JSON生成/校验，不影响产品代码或真实请求，未将失败命令计PASS。
