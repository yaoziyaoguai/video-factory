# 05 确定性验收与进入真实 QA 的条件

每个 ID 在 RESULT 中写 PASS/FAIL/NOT_VERIFIED、准确测试名/命令、退出码与证据文件。不能把本表整行复制为已通过，也不能用“相关单测全绿”代替该行为证据。

证据分层：D = 本文确定性控制/协议/组件验证，Q = QA 包真实模型/浏览器/媒体验证。D通过不代替Q；同样，漂亮样片不代替权限与恢复负例。

## 1. 基线与已有缺陷

| ID | 必须证明的行为 | 最低测试接缝 |
| --- | --- | --- |
| D11-01 | 三入口新建都到导演草稿等待，脚本/分镜/媒体调用均0；模板缺失不阻断 | 正式 Studio→Pipeline→SQLite，替换外部 transport |
| D11-02 | 确认导演只生成脚本并等待；确认脚本只生成分镜并等待；确认分镜才编译到报价；都不消费图片/视频 | 同上，捕获各角色调用与实际产物 |
| D11-03 | generic approve/retry/resume/override/direct Pipeline 不能绕过任一确认；没有已确认最终计划不允许 quote/asset create | HTTP +领域入口负例，不仅 UI disabled |
| D11-04 | 无计划不补强制三拍；未触碰自动建议不写 visualIntent；明确编辑/采用才是要求 | TodayPage/NewRunDialog→真实 DTO→实际角色输入 |
| D11-05 | checkpoint 中 host review 空/非空列表可合法重放；host丢失/损坏/越界引用仍拒绝；producer不重跑 | 实际 role loop+File checkpoint，两次启动 |
| D11-06 | 真实宿主误分类被独审纠正后，下一修订不再收到被撤销的补料命令；部分真缺料仍阻断 | assessTreatmentReadiness→loop，非手写“正确host” |
| D11-07 | ordinary illustration 的 stock no-match 可由导演改允许路线并编译/新报价；真取证/禁止生成/不支持Provider仍拒绝 | 正式规划组合→validator→编译，不能手改脚本fixture解锁 |
| D11-08 | 同义候选的问号、中文数字/阿拉伯数字不造成 skip/0 差异；空泛语义仍由真实语义决策合同处理 | 总编结果→editorial-decision→采用门 |
| D11-09 | treatment真实输入/审计/identity含系列约束；canon修改失效，无关历史变化不失效 | 实际端口捕获+identity+重启 |

## 2. 讨论、确认、并发与崩溃

| ID | 必须证明的行为 | 最低测试接缝 |
| --- | --- | --- |
| D11-10 | 正常等待不是failed；离开/读取/重启保留草稿与gate，零新模型调用 | 正式持久化/Studio启动恢复 |
| D11-11 | explain只回话；propose只添备选；revise改当前待确认稿；clarify不修改；任何文本“同意”不直接推进 | strict discussion response→领域动作→图 |
| D11-12 | adopt/undo不调用模型；基于旧SHA的提案不可覆盖新稿；撤销保留完整历史与费用 | 同上+持久化 |
| D11-13 | 新草稿没有检查通过记录；confirm审的就是用户看见的稿件；检查失败后等用户修改；新稿不沿用旧确认 | producer/audit捕获candidate SHA与调用次序 |
| D11-14 | 相同commandId同body重复只执行一次并重放结果；同ID异body409；不同ID双confirm最多一次推进 | 真实HTTP并发+Pipeline lease+SQLite |
| D11-15 | 过期run/review revision、baseSHA、跨stage、跨run引用拒绝且零写入/调用 | parser→持锁业务检查 |
| D11-16 | command落盘后/模型受理后/模型成功后/发布前/SQLite成功而run投影前分别崩溃，恢复不丢输入不重发 | 确定性failpoints+真实socket/durable/store，不杀真实付费任务 |
| D11-17 | accepted_unknown只观察原request；迟到成功/失败绑定原稿，不覆盖新稿、不洗轮次、不解除暂停 | 正式Broker/client/role/checkpoint组合 |
| D11-18 | 消息超过多轮样本仍可继续（例如12轮），不设产品讨论次数门；单次结构修复/错误重试仍有界 | 注入快速transport；不得真实模型灌12轮 |

## 3. UI/API 可用性

| ID | 必须证明的行为 | 最低测试接缝 |
| --- | --- | --- |
| D11-19 | 三阶段实际文档以卡片/正文可读渲染，状态明确，只有正确确认动作可推进 | 当前Studio组件，真实DTO数据 |
| D11-20 | 改动列表/上一版/备选采用/点选镜头讨论范围正确；无未生成假预览 | 组件事件→请求断言+领域结果回显 |
| D11-21 | 发送失败保留草稿，202后观察原操作；刷新不丢已发消息；自动轮询不覆盖正在输入 | UI异步/错误/恢复测试 |
| D11-22 | 两窗口版本冲突有明确提示，旧窗口不覆盖；未保存模型设置不偷生效；确认禁用有理由 | UI+HTTP 409组合 |
| D11-23 | 390px和桌面布局、焦点、按钮标签、中文IME、长内容、无水平遮挡满足01 | 组件布局/键盘；实际视觉由Q补证 |
| D11-24 | 消息/草稿/提案接口要求登录并遵守run访问；恶意HTML只显示文本，非法路径与文档字段拒绝 | Fastify inject+渲染+领域parser |

## 4. 依赖、恢复与原能力

| ID | 必须证明的行为 | 最低测试接缝 |
| --- | --- | --- |
| D11-25 | rate185→120/pause1→2后实际effective brief、script/director voiceTiming、voice receipt和返工一致；无关素材保留 | 正式声音节点编辑→依赖复核→worker参数 |
| D11-26 | voice/profile/mastering单改只影响消费者，不无故重做构思/媒体；unsupported pause不产生假效果或假失效 | Provider参数适配+正式影响矩阵 |
| D11-27 | MiniMax显示相对速度说明；Kokoro停顿未执行如实禁用；macOS能力不被删 | VoiceStudio+Python已有实现参数测试 |
| D11-28 | 改系列/用户核心要求回最早受影响阶段；当前草稿与引用保持；未确认不能以旧计划继续 | 配置/返回上游→图→授权负例 |
| D11-29 | 局部返工预填真实finding指向的要求，保留其它镜头和媒体SHA；上推方案变更先等讨论确认 | 正式rework→seed→当前gate→编译 |
| D11-30 | 切角色模型只影响对应及下游；实际路由与保存一致；在途未知不切换 | ProductionStudio配置→fallback/原任务恢复 |
| D11-31 | 旧run可读，缺新确认不伪造通过；新制作API/CLI不能显式关闭gate；旧在途只回收结果 | 历史fixture+当前server/Pipeline |
| D11-32 | 只在最后分镜已确认后发布正式plan；seed不能把未确认draft当accepted；模型/能力/来源变更使旧确认无效 | graph→publication→跨thread恢复 |
| D11-33 | 无图片/视频批准零create；当前plan digest与报价/子授权一致；新路线/新增范围重新报价 | 现有production-authorization正式组合 |
| D11-34 | 模板CRUD与历史保留；三入口、技能/模型选择、动态时长、母片复用、局部范围、TTS自动记账、双真实模型要求不退化 | 既有相关回归+新增联合断言 |

## 5. 原文、协议与性能

| ID | 必须证明的行为 | 最低测试接缝 |
| --- | --- | --- |
| D11-35 | 本文/段落/URL/SHA真正进入总编和独审；文章中有而标题没有的合法事实可引用；不存在段落拒绝 | reader→payload→Broker parser→candidate |
| D11-36 | 无正文/登录页/动态榜单/截断/超时/超限都诚实标注，不虚构已读或已核实 | 确定性HTTP/HTML输入，UI展示 |
| D11-37 | redirect到内网、IPv6映射、DNS rebinding、非标准协议/端口、过量解压、提示注入被约束 | 注入网络/DNS port，禁止实际探测元数据/内网 |
| D11-38 | 8组/2URL/并发3/总截止/TTL/同URL合并生效；新nonce不重读有效缓存；运行中引用不受缓存刷新影响 | 可控clock/transport+原子文件缓存 |
| D11-39 | actual supported kinds=descriptor=normalizer=health digests；creative-discussion各intent在OpenAI/ZAI/source/dist一致；非法额外字段拒绝 | 正式parser/executor/Broker/client全边界，非只有hash相等 |
| D11-40 | 三阶段producer/讨论/独审共同依据与identity一致；旧审计、不可信正文、自动建议不可变成新硬要求 | 实际payload与恢复时输入捕获 |
| D11-41 | 热点采用后可信来源快照到ProductionBrief/treatment suppliedSources/脚本/导演；不能被client伪造verified | 正式采用→生产组合 |
| D11-42 | 原文失败不影响其它两个入口；title-only不能通过事实承诺门；多转载不能假作独立核实 | 入口/来源负例组合 |
| D11-43 | 调用数按物理request去重；解释/修改/确认审计分别记录；刷新/轮询为0，未知如实 | receipt/trace→Studio进行中/重启投影 |
| D11-44 | 人工等待、排队、模型、结构修复、预处理时间区分；时段重叠不相加，缺时间戳不编数值 | 可控时间trace→UI；不宣称真实提速 |
| D11-45 | 主片语义编译和时间轴仍覆盖完整画面与关键兑现；VOICE_DOES_NOT_FIT不被裁切/加速掩盖；双审证据不减少 | 原timeline/voice/render/visual-review/rework回归 |
| D11-46 | 全量TS/Broker/Studio/Python/build/typecheck/package及新增测试收录通过；本轮diff无越界重构或秘密 | 03末尾准确命令+diff与baseline核对 |

## 6. 测试质量要求

- 先建立每类失败行为再修；使用通用输入、语义相同不同措辞、真实缺料负例，不在产品代码出现测试题/sceneId/runId白名单。
- 相邻节点组合使用前一真实模块输出，避免手工填一个永远正确的host/脚本掩盖交接问题。
- 控制流/并发测试可以在边界注入假transport，但图、SQLite、run store、解析、授权必须真实；标明这不是外部模型/真实媒体证据。
- 真实 QA 不能使用测试替身。新增自测不能靠mock直接返回“已确认/已授权”绕过应该验证的路径。
- 失败、超时、输出被截断、进程未退出不算通过。既有skip必须解释；与本轮有关的新skip阻止代码放行。

## 7. 进入 QA 的门槛

所有 D11 中涉及控制/合同的行为有通过证据，全部集中命令成功，无已知阻断三入口/确认/付费安全/恢复的代码缺陷；UI真实视觉、真实语义质量/成片留给Q。

执行端自查确认后标 `CODE_VALIDATED` 并进入测试包。**“确认没问题”在此指完成这些有限而明确的检查，不是声称穷尽所有缺陷。**

若自动化无法验证某项，写明原因与替代证据；不能默默改成不测。只有纯外部真实行为可由Q补证，源码恢复/授权负例不能全部推给昂贵真实测试。
