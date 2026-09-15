# 正式行为测试、集中回归与真实本地 QA

本包验收编号 V01–V15 补齐全部11项真实问题的失败序列。原 [D11 验收](../revision11/implementation/05_ACCEPTANCE.md) 和 [Q11 用例](../revision11/qa/02_CASES_AND_REPORT.md) 的安全/用户交互要求保留。已有 D11 PASS 记录不能替代以下新增序列；不需要重新开发已有功能。

**执行衔接：F01～F11集中修复与以下代码检查通过后，自动进入第3～5节的正式本地部署、QA技能和E2E。无需再等用户或另一窗口放行。** 第一次真实QA集中记录；全部可达项测完后，对本范围遗漏集中修正并作一次必要复验。不得每测出一个问题就改代码、重部署；也不得只交编译结果而没测试。

## 1. 建立红灯与绿色证据

实施阶段只在隔离测试数据运行。外部模型/媒体 transport 可以被注入替身，Studio HTTP、正式输入 parser、ProductionPipeline、LangGraph、SQLite、RunStore、lease、状态发布与费用规则使用正式模块。真实 QA 绝不能连接替身。

| ID | 必须证明的行为 | 最低测试链与负例 |
| --- | --- | --- |
| V01 预算往返 | 新建对话框实际 DTO 填预算后能创建导演草稿等待；值持久化并进入约定的规划上下文 | UI 提交→Fastify→正式 Studio/Pipeline→brief round-trip；省略/0/正数/非法/NaN（直接调用边界）/负值/超大非有限值；其它未知字段仍拒绝。预算不是 spend approval，媒体=0 |
| V02 操作终态收敛 | adopt/undo 成功后当前文档、review phase、按钮与命令终态一致；用户不必刷新解锁 | 正式 HTTP command→SQLite/RunStore→命令查询→真实 RunPage，而不只测孤立 Panel；覆盖快速完成、同 revision 完成、响应丢失、旧 GET 晚到、refresh/离页、失败、不同run切换，零额外 produce/audit/media |
| V03 安全诊断 | executor 拒绝在 durable、client、checkpoint、Studio 保留实际可取的错误层级/安全依据 | 正式子进程 executor 与已受理 Broker outcome 组合；把 Broker 422 与上游状态分开；未知不编造；故意含伪密钥、Authorization、任意路径/URL参数、长文本的 stderr/stdout 不泄漏 |
| V04 确认消费 | 三阶段 confirm 审的就是用户看见/采用的 SHA；审通过才进入下一阶段并等待；审核失败保留当前稿与动作 | 正式 adapter→Unix socket Broker parser/executor→loop→图→Studio；三阶段、两个 executor、source/dist；生成/讨论/审核共用正式输入。注入合法真实合同结果而不手写 confirmed 状态；失败、unknown、晚到结果与重启不重投 |
| V05 失败与统计 | treatment audit failed 在所有视图均归 treatment/check；原命令终态不残留 running；此前讨论/本次审计计数一致 | trace/receipt/operation/checkpoint→Studio→RunPage/节点面板；初稿+解释+备选共3、采用0、确认审计1只是序列示例，断言实际 request 身份；含结构修复/失败恢复/观察0增量/重启时间 |
| V06 同run保留草稿 | 采用→确认检查失败→仅改script模型→恢复，treatment当前稿SHA、历史、采用指令不回退；失败检查不会变成pass | 正式 Studio 模型保存→Pipeline失效→新planning identity→SQLite恢复→当前review；同时覆盖初稿等待/审查通过的上游确认、只改director、刷新重启；下次实际script走新模型 |
| V07 正确失效及并发 | 应失效的身份不能继续复用确认；未知任务不能换模型重新提交 | 改对应阶段模型、核心要求、必要系列来源、声音有效节奏；双窗口旧revision/SHA、跨run/阶段提案引用；用户变更只影响实际消费者，0越权写入/0旧授权新买 |
| V08 组合主链与费用安全 | 初稿→讨论/备选/采用→确认→脚本→确认→分镜→确认→正式计划/报价；恢复不丢稿、不绕gate | 正式 HTTP/Pipeline/SQLite 与可控外部依赖；generic approve/retry/resume/override/CLI 不能越过当前确认；未付费0 create、新范围旧报价不能批准；声音/媒体复用/局部返工/双审原安全回归 |
| V09 测试与产物一致 | 本次用例进入正式脚本，集中回归和source/dist均通过，部署的是本轮新构建 | 保存命令、完整日志、exit、skip理由、artifact SHA与基线diff；运行旧探针前核对其当前合同，不能只比digest或用测试数量替代行为证据 |
| V10 未知结果安全收口 | executor已退出且无远端查询能力时，保存诊断并从本地“运行中”收口到明确待处理；未知不能伪装已失败或未扣费 | 真实ZAI executor/模拟网络→Broker durable→原任务查询→client/loop→Studio；未发送、发送后无响应、收到响应头后断开、可查询远端、Broker崩溃落盘失败分别覆盖；重启不丢证据/不重发，已知终态可恢复、未知禁止自动换ID |
| V11 共享模型合同与入口失败 | F03/F07共同请求问题有明确证据，不能只修单任务；失败时原候选保留且显示可行动原因 | 全部11类正式output schema离线检查/真实executor参数捕获，包含深层uniqueItems、nullable等实际支持情况；topic-ideas、role-audit两类正式Broker→Studio组合，热点fallback诚实/系列审计失败不采用；领域约束未变弱、secret不泄漏。两类真实成功由Q补证 |
| V12 正文真实网络接缝 | F08不再因Node callback形状错误全失败，网络安全和来源身份不倒退 | 必须执行正式requestPinned的lookup适配（不能整体mock request）；Node all=true数组/false标量、IPv4/IPv6、固定已审IP及原TLS hostname；多地址含私网拒绝、重定向/取消释放、解压上限/超时、缓存命中/失败TTL与来源重新绑定；系统故障与正文未读在UI分清 |
| V13 声音修改透明 | 节奏预设保留已选演员/provider；保存后实际生效参数与显示一致 | 多初始profile切换所有现有节奏预设；演员显式切换才改route；MiniMax相对速度/Kokoro停顿未执行/macOS与后处理如实；新建/全局/当前run调用点保留共同配置与失效边界，试听不冒充正式音轨 |
| V14 复盘定位一致 | 当前复盘不推荐暂停中的模板作为新制作优化手段，保留历史与诚实统计 | 无样本、纯技术failed、终审rejected、历史模板有样本/空/接口失败；技术问题不算内容失败，历史模板不是新作品指标；不影响模板CRUD |
| V15 搜索可达设置 | 声音/配音/音色/语速/停顿能找到实际声音设置，点击后分区可见 | AppShell搜索→真实ResourcesPage hash激活；从其它页面和已在resources两种情况、刷新/返回/焦点/Escape/无结果；制作/机会/模板旧搜索不退化，0模型调用 |


特别说明：

- V04 的确定性成功不证明 OpenAI 真实外部 role-audit 已修；F03 必须另有正式本地真实确认消费证据，或如实交回外部失败。
- V06 不应以“必须已confirmed才保存”把用户采用稿丢掉；也不应把未通过的稿件伪造确认。保存工作成果和允许推进是两个边界。
- 原报告部分 D11 关联编号不准确，本包 FINDINGS 已给出校正映射，不修改旧报告。
- 不能通过改测试期望来接受错误字段丢弃、旧稿回退、假运行或来源/授权放宽。
- 不把大文件拆分、图谱更新修复或引入新缓存/版本平台当成任务支线。

覆盖对照（最终报告逐项填写，不凭总测试数勾选）：F01→V01/V08；F02→V02；F03→V03/V04/V11；F04→V05；F05→V06/V07；F06→V03/V05/V10；F07→V03/V11；F08→V12；F09→V07/V13；F10→V14；F11→V15。V09是所有项的产物与正式测试入口要求。

## 2. 已有测试入口与准确命令

核对当前源码后优先扩展：

- `apps/studio/test/client.test.tsx`、`creative-discussion-panel.test.tsx`、`server.test.ts`、`production-planning-editing.test.ts`、`production-planning-stages.test.ts`、`text-task-production-recovery.test.ts`。
- `packages/production-pipeline/test/creative-review.test.ts`、`creative-planning.test.ts`、`production-planning-closure.test.ts`、`production-authorization.test.ts`、`production-pipeline.test.ts`、`role-agent-loop.test.ts`。
- `apps/codex-broker/test/codex-executor.test.ts`、`broker-server.test.ts`、`task-definitions.test.ts`、`topic-script-contract.cross.test.ts`、`zai-code-plan-executor.test.ts`。
- `apps/studio/test/trend-article-reader.test.ts`、`trend-opportunity-agent.test.ts`、`candidate-inbox.test.ts`、`local-capabilities.test.ts`；声音、复盘、搜索扩展当前`client.test.tsx`/`creative-os.test.tsx`及实际现有对应组件用例，不在文档猜一个不存在的测试文件。
- 新 RunPage/HTTP 组合文件可按现有目录约定增加；Studio Node 测试脚本是显式文件列表，新增后需接入，不能只在个人命令中跑过。

聚焦 Node TS 测试从仓库根：

```sh
node --test --test-concurrency=1 --import tsx <准确测试文件列表>
```

Studio 组件在 `apps/studio` 执行：

```sh
npx --no-install vitest run <准确测试文件> --reporter=dot
```

使用 workspace 包产物的用例先构建 pipeline。Node 和 better-sqlite3 ABI 必须一致；既有项目 Python 使用 unittest，不因无 pytest 安装新框架。仅为解决已证实 ABI/锁文件运行问题可以恢复现有依赖，不趁机升级工具或改依赖版本。

本包全部范围收口后，从仓库根按顺序跑：

```sh
npm run build:pipeline
npm run test:ts
npm run test:broker
npm run studio:test
npm run typecheck
npm run build
npm run test:package
PYTHONPATH=src .venv/bin/python -m unittest discover -s tests
node --import tsx docs/codex-collaboration/evidence/r6-contract-boundary-review.mjs
VF_REVIEW_DIST=1 node --import tsx docs/codex-collaboration/evidence/r6-contract-boundary-review.mjs
node --import tsx docs/codex-collaboration/evidence/r9-planning-contract-boundary.mjs
VF_REVIEW_DIST=1 node --import tsx docs/codex-collaboration/evidence/r9-planning-contract-boundary.mjs
node --import tsx docs/codex-collaboration/evidence/r11-contract-boundary.mjs
VF_REVIEW_DIST=1 node --import tsx docs/codex-collaboration/evidence/r11-contract-boundary.mjs
git diff --check
```

构建/脚本会清写同一 dist，串行执行；独立纯测试可并行。已有 R11 contract probe 不足以覆盖新的真实确认序列时补正式测试。每条命令保存完整输出与退出码；使用管道保存时保留原测试退出码，不能把 tee 成功当测试通过。输出截断、超时和缺退出码不能记PASS。已经逐项运行后不再叠加 npm test 重复整套。

## 3. 测试权限与当前环境

已授权范围详见 MASTER_PROMPT，执行者可直接做本地部署和测试，不需另请“付费 QA 权限”。原 [R11 QA运行手册](../revision11/qa/01_RUNBOOK.md) 的操作/安全细节继续适用，当前本包明确覆盖其可能造成“每小项等待”的解释。

测试前完整读取当前可用 QA 与浏览器技能。本机可查：

- `/Users/jinkun.wang/.codex/skills/gstack-qa/SKILL.md`。
- `/Users/jinkun.wang/.agents/skills/gstack/qa/SKILL.md`。
- 当前会话已安装的 in-app browser/browse 技能；以实际工具清单和技能文档为准。

技能缺附件可用本包矩阵与报告格式；当前工具不可用先查现成等价浏览器能力。不能因技能要求干净树、一bug一commit或遥测而违反本次指令；不自动升级/发送资料。没有真实浏览器能力时可以继续确定性和接口验证，但明确浏览器用例未验证，不用API冒充点击。

当前环境只是接手导航，执行前重新核对：

- Studio：`http://127.0.0.1:4317`。
- workspace：`/Users/jinkun.wang/work_space/veidofactory/workspace/qa-r11-20260914-001`。
- socket：`/Users/jinkun.wang/work_space/veidofactory/.local/runtime/qa-r11-20260914-001/{openai,zai}/worker.sock`。
- 初始实际配置：OpenAI `gpt-5.6-sol / xhigh`，ZAI文本 `glm-5.3 / max`；有图路由可能为 `glm-5.3-flash`，以实际receipt为准。
- 构建入口为 `npm run build`，Broker正式 `node apps/codex-broker/dist/main.js`，Studio正式 `npm run studio:start`。dev启动脚本仅可作配置参考。
- socket、cwd、workspace 均使用绝对路径，Studio显式连接两个正式Broker，health kinds/parser/descriptor/digest与最终构建一致。
- 09:28报告中旧GLM脚本仍durable accepted/无outcome，Studio已本地failed。不能把“已failed/health空闲”当作远端安全终态；只观察原身份，不直接重启/复制提交。服务占用时用隔离运行目录和空闲端口完成新构建的独立样片验证，不接管其它窗口业务。
- 不更换任务workspace来伪装刷新/重启恢复；恢复用例持续使用同一运行目录。新样片用自己的QA数据，旧run与证据保持原样。只有本轮自建且明确用于CRUD测试的模板/系列允许按正常界面删除。

## 4. 费用与执行止损

沿用 R11 当前单轮总止损 `¥50.00`，该修复包不新增50元。报告截至资料核对时已花/未知均0，但启动前要读实时账本和本轮其它任务；报告滞后不能作为免费依据。R9 ¥8.75单列历史不重复算入R11。

每次新增付费前计算：

`本轮已确定现金 + 本轮在途/未知/未结授权最大暴露 + 本次新增最大暴露 ≤ ¥50.00`

同父scope与子请求去重；不重复计算已付与余额。TTS自动执行也要预留，按量文本如实际发生也计入。预算足够且报价/范围合理，执行者自己点击确认及追加，不再向用户逐笔确认。主片首次媒体尽量留返工/TTS余量；35元是分配建议，不是硬产品限额。不得靠降低既定质量/强度或更换题材硬凑成功。

只有费用将超出剩余、出现无法确定上界的现金风险或需要新登录/破坏性权限时暂停相关路径并给出具体缺口。不存在原任务是否执行/扣费不明就免费重提的情况。

真实QA一轮集中记录，然后处理同范围遗漏并做一次必要复验。阶段内操作要有目的，不灌12轮真实讨论测试容量。明确合同错误不要用第二次真实提交复现；unknown仅查原请求；同路径同根因在条件变化后最多一次受控恢复，再次失败停链。独立非付费UI/入口继续测；若涉及数据丢失、错误购买或绕过确认，停止相关新写入并保存现场。

慢任务记录：受理、排队、模型执行、结构修复、产物返回、本地消费与用户等待。保留实际deadline，不加超时解决。无变化不密集重复查询；有真实进展可正常观察。R9的“最多三轮”不能解释R11用户讨论等待，不能把人工等待算模型耗时。

## 5. 一轮真实 QA 覆盖顺序

沿用原 Q11-01～Q11-12 逐项报告，原始测试文本可直接从旧报告/原Q11取用，固定样本后不靠换题碰运气。

| 顺序/原用例 | 本轮必须实际做的事 | 证据 |
| --- | --- | --- |
| Q11-01 环境 | 新dist/模型/声音/素材能力与登录；记录真实任务是否空闲 | 构建SHA、health、实际receipt，不能只健康200 |
| Q11-02 三阶段 | 带合法预算创建主片；导演解释→备选→采用→确认；脚本修改/撤销/确认；分镜按镜头讨论/确认 | 三个当前稿SHA/确认identity、实际后续阶段、confirm前0媒体；F01/F02直接复验 |
| Q11-09/10 恢复 | 在没有在途的合法等待态切脚本模型；已采用构思不回退；刷新、双窗口冲突、正常重启后仍一致 | 前后稿件/消息/确认/实际下一调用；F05失败态在确定性测试覆盖，真实若自然出现再取证，不故意制造付费失败 |
| Q11-03 报价 | 暂不继续、调整方案、同意；旧报价不能购买新范围；额度内新增曝光自己确认 | 正式quote/scope/digest、未确认0create |
| Q11-04 制作 | 一条当前新样片真实媒体→预检→TTS→渲染→完整播放/听音 | 媒体taskId/复用SHA/receipt、真实音轨、ffprobe与内容评价；画面预检失败记录具体责任 |
| Q11-05 双审返工 | 同一新片/同一证据集合由两个不同真实模型独立审；按真实finding或明确的人为局部修改做有界返工 | 两模型身份/SHA/报告、未影响媒体复用、必要新报价、新片与新双审；不伪造finding |
| Q11-06 热点 | 一次有界真实刷新，读入围文章并核对段落/来源，采用后进导演讨论 | read/partial/title_only事实与引用；负例正确停住不等于正例通过 |
| Q11-07 系列/第二模型 | 当前能力可制作的QA系列，明确canon；使用另一个真实文本模型，至少到合法讨论/确认与可达报价 | 实际角色输入/模型、系列约束；不买第二条主片 |
| Q11-08 缺来源负例 | 必须本人真实取证却没有来源且不允许模拟的样本及时解释并停住 | 原因具体、不能confirm绕过、媒体0；与可生成示意正例分开 |
| Q11-09 声音/路线 | 有效rate/pause修改、实际Provider能力、依赖与不重买无关素材；stock no-match若自然出现检查合法改路线 | 共同配置→角色→TTS receipt；未出现记NOT_OBSERVED |
| Q11-10/11 可用性 | 1440/390布局、IME、焦点、输入保留、查询、暂停/继续、设置/素材/模板历史与本地交付可达项 | 截图/操作与真实状态；未达后半程如实记缺口 |
| Q11-12 统计 | 汇总所有实际请求/阶段/耗时、订阅与现金、在途未知与剩余 | UI与原始receipt一致；不把查询当模型、重叠时间不重复相加 |

主片应保留通用创作目标、正常旁白和统一视觉，不用空白片/说明卡/旧成片当通过。角色生成/审计的正负语义、完整成片质量单列；确定性替身不证明语义质量。不能实际听音时标记听感未验证，不能用转录或音轨存在冒充听过。

F06 必须证明原请求无远端结果时页面不再假装本地模型持续执行，仍保留原请求与潜在执行/费用未知；不能强改durable为completed_failure来解锁。底层断连原因仍无证据时写待查。

F03/F07应通过实际OpenAI role-audit消费到下一阶段，另有真实topic-ideas成功的证据，并用GLM独立验证正式合同；两个Broker都能发布health不够。F08修复后不能只证明不报IP错误，还要核对正文和引用。F09～F11分别在声音页、复盘页、声音搜索落点作真实点击复验。若同因仍失败，交回安全诊断和已完成独立覆盖，不强称全主链通过。

本次E2E指第5节这条真实浏览器业务链，不是盲跑名叫`test:e2e`的命令。项目现有`npm run test:e2e`可能走旧自动流程或自行调用外部服务；未先检查其覆盖/配置/授权消耗，不将它并入免费回归批次，也不把它通过等同三阶段讨论链通过。

下游尚未真实跑过，不预先断言没有问题。报价/媒体/TTS/渲染/双审/返工每个边界都要核对“前一阶段实际输出是否被下一阶段正确消费”。出现新问题时先保存HTTP、request/command、当前稿/计划/媒体SHA及安全错误链；尽量测完其它可达项。属于本包同根因遗漏可集中补修一次并必要复验；确需新产品选择/明显扩大架构或超过¥50才暂停相关链，给出最小待决项。不要为赶进度直接将stage设succeeded、手填产物或关闭审查。

## 6. 最终交付格式

统一 RESULT 追加 `R11 QA集中修复 / VF-R11-QA-REPAIR-20260914`，详细报告为 `docs/qa/videofactory-real-local-qa-<日期>-r11-repair.md`，证据放其同名 `-assets/` 或既有 evidence 目录。不改旧R11报告结论来迎合新实现。

必须包含：

1. 实际起止HEAD/源码差异、对应F01–F11根因（已证实/推测/待查）、最小修改文件；同根因合并修复但保留十一项逐项结果。
2. V01–V15与Q11-01～12逐项PASS/FAIL/PARTIAL/BLOCKED/NOT_VERIFIED；准确命令、完整日志/exit及skip原因。
3. 真实成片、音轨、两个独审、局部返工路径/SHA；没有的明确列出。
4. 模型requested/actual与强度、所有相关调用/耗时、现金/在途/未知、未结请求和原任务观察方法。
5. 代码验证状态、QA执行状态、产品验收分别写；已完成有界验证即可交回READY_FOR_REVIEW，但不能掩盖仍失败的F03或其他阻断。若未修完写CHANGES_REQUIRED及原因，不写ACCEPTED。
6. 结束时服务/端口/workspace与在途状态。没有费用或发布副作用的断言必须有实际记录支持。
