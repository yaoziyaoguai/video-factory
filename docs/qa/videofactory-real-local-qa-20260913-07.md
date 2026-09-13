# VideoFactory 第七轮真实本地 QA 报告（revision 8）

- 报告编号：`VF-REAL-LOCAL-QA-20260913-07`
- 日期：2026-09-13
- 模式：`qa-only` / report-only；真实 production dist、真实 OpenAI/GLM 模型；QA 阶段只记录、不修改产品代码
- 分支：`codex/final-dual-review-cloud-acceptance`
- HEAD：`570fe6e59e072c4965c86769bf2096825f003383`
- 目标：`http://127.0.0.1:4317`
- 执行时段：约 13:16–14:51 +0800；其中绝大多数时间为串行真实模型等待
- 页面/入口：创作台、自有想法、制作记录、模板、热点、系列；截图 22 张
- 前端：React/Vite SPA
- 结论：`DONE_WITH_CONCERNS`；本轮有界 QA 已执行完，**产品验收未通过**

## 1. QA 前环境与安全门

- QA 只在 revision 8 的确定性回归、类型检查、正式构建、source/dist 组合验证全部通过后开始。
- 13:16 启动的正式服务：OpenAI Broker PID 81826，ZAI Broker PID 81827，Studio PID 81829；三个 cwd 均为本仓库。OpenAI 为 `gpt-5.6-sol/xhigh`，ZAI 文本为 `glm-5.3/max`、视觉为 `glm-5.3-flash`。
- 两个 Broker 均发布 10 task kinds / 10 contracts；Studio health 为 `ok`，Python、FFmpeg、ffprobe、say 均可用。旧 durable/checkpoint/workspace/登录和历史 run 保留；没有 fake Broker 或测试替身接入 Studio。
- 最终服务：OpenAI Broker PID 81826，ZAI Broker PID 81827，Studio PID 21869；最终 dist 时间为 Broker 13:10:40、Studio server 13:10:51、client 13:10:49。最终两个 Broker 均 `active=0, queued=0`。
- 操作偏差：第一次 Studio TERM 前确认了 OpenAI `active=0`，但漏查 ZAI；重启后才发现 ZAI `active=1`。该 ZAI 任务未被终止，继续在 Broker 内完成，计数从 0 增至 1。其发生时间与打开热点/系列只读页面重合，但公开状态不暴露 taskId/kind，不能把来源写成已证实。关闭额外页面并等两个 Broker 都空闲后，14:49 再次正常 TERM/启动 Studio，PID 21869；run 状态、workspace 与登录继续可读，最终 health 正常。

## 2. E01–E07 结果

| ID | 状态 | revision 8 真实证据 |
| --- | --- | --- |
| E01 | FAIL / BLOCKED | 三个自有想法 run 均通过正式 Provider/Broker 前门，但分别停在 `needs_user`、图库候选 `needs_source`、导演结构失败；负例错误越过构思进入编剧。没有任何自有想法到报价。热点 0 条可采用；系列没有一条当前能力内且状态可直接开工的正常单集，因此另两入口也未到报价。 |
| E02 | PARTIAL / NOT_VERIFIED | `needs_user` 的“调整方案”预填能创建新 run；运行中刷新和查询原任务不重复提交。一次查询在原任务刚完成时返回 409。导演失败后选择 GLM 的配置 PUT 返回 409，随后 retry 仍使用 OpenAI。没有到报价，三种报价动作均未验证。 |
| E03 | BLOCKED / NOT_VERIFIED | 所有 run 均停在 planning；媒体 create=0、TTS=0、渲染=0、Provider media taskId=无、新增现金费用 ¥0.00。 |
| E04 | BLOCKED / NOT_VERIFIED | OpenAI/GLM 都 ready，但没有新成片/evidence SHA，未发生同 SHA 双真实模型审片。 |
| E05 | PARTIAL / BLOCKED | `needs_user` 原因与建议成功预填到调整方案，且新 run 记录源 run；没有真实成片审片结果，无法验证审片建议驱动的局部返工与媒体复用。 |
| E06 | FAIL / PARTIAL | 390 宽无横向溢出；刷新后原任务身份保留；查询不增加调用。负例 20 分钟 Provider 失败后页面长期保持“制作中”且没有重试入口；重启后才变为失败，同时已通过的构思在 planningStages 中变回 pending，不能证明“恢复推进且保留完成阶段”。第二次在两个 Broker 都空闲时正常重启，失败状态稳定保留。 |
| E07 | BLOCKED / NOT_VERIFIED | 无新成片，无法检查真实帧数、长度、声画同步、开头承诺、中段推进、结尾兑现和双审质量。 |

## 3. 真实样本与调用、耗时

### 3.1 抽象圆形正例：非局部决策能停住，但不是可制作正例

- run：`run-2344bb51-be40-4dce-b8e4-d7ed5e42223a`，05:19:08–05:25:18，共约 6 分 10 秒。
- 输入允许 AI 抽象圆形，明确不声称真实实验。真实 OpenAI 6 次：构思 `produce=2/audit=2`，编剧 `produce=1/audit=1`；媒体/TTS=0。
- 结果：编剧独立审计以 `needs_user` 停住，同角色后续 produce 增量 0。原因是用户的统一 AI 抽象路线与模板中两个 stock-only 槽位冲突。页面给出具体冲突和调整入口。
- 调整入口确实预填失败原因与分阶段建议，新 run 能确认“允许部分 AI 示意、stock-only 槽位不得用 AIGC 冒充证据”。
- 结论：这是 F03 从真实适配器到 Studio 的外部处置消费证据，不是生产后半程通过。
- 证据：`03-positive-idea-filled.png`–`07-positive-attempt-needs-user.png`、`11-user-choice-prefilled-adjustment.png`。

### 3.2 Stock 城市街景：模型切换无效，随后又被派生约束推成实证

- run：`run-32ba953d-e44b-4b44-9ae0-882e80951928`，05:29:24–05:53:22，共约 23 分 58 秒。
- 输入明确“不同地点只作视觉表达、不声称同地点实测”，stock-only。构思和脚本一次通过。
- 导演第一次真实 produce 约 6 分 36 秒后 Provider 失败。页面给出换模型与重试；选择 `GLM-5.3` 时 `PUT /execution-configuration` 返回 409，紧接着 `POST /retry` 返回 200，但恢复仍使用 `gpt-5.6-sol`。这不是“用户选了 GLM 后 GLM 也失败”。
- 受控恢复后导演通过；候选排序最终因多个镜头没有达到自动采用阈值而 `needs_source`。该 run 共 17 次文本模型尝试（16 completed + 1 failed）：构思 2、脚本 2、导演两段 checkpoint 合计 7、候选排序两段 checkpoint 合计 6。没有 media/TTS create。
- 新风险：用户已否认受控实证，但自动派生的 `visualPlan` 仍要求“固定主体、机位和相同条件，仅改变变量”，把普通视觉表达重新推成需要专属同源素材的任务。已证实最终 halt 来自候选不足；该派生约束是否是全部低匹配的唯一原因仍是推测。
- 证据：`08-stock-positive-ready.png`–`10-stock-positive-needs-source.png`；浏览器 network/console 保存 execution-configuration 409 与 retry 200。

### 3.3 按 `needs_user` 建议调整后的正例：导演结构修复失败，调用与耗时说明失真

- run：`run-eb552d6d-4c73-4e54-9e60-4841d332dd9e`，05:56:08–06:11:28，共 15 分 19 秒。
- 真实 OpenAI 14 次且全部 completed：构思 `2 produce + 2 audit`；编剧 `2 produce + 3 audit`，含 1 次结构修复；导演 `4 produce + 1 audit`，含 2 次结构修复。
- 构思、编剧通过；导演第一次审计给 `revise_here`，宿主正确留在本角色。下一轮连续两次返回 `shots[1].temporalBeats must contain at least two timed beats`，最终失败，没有盲目重试。
- 页面把整个 `creative-planning` 节点显示为“5 次模型调用、2 次自动重试”，只反映最后一个导演 checkpoint；构思与编剧的 9 次调用消失。页面又把 15 分 19 秒拆成 Provider 3 分 25 秒、本地处理 11 分 55 秒，而三个角色 checkpoint 的模型 phaseDurations 合计约 15 分 19 秒。真实数据因此仍不能让用户理解总调用数和慢在哪里。
- 证据：`13-adjusted-positive-structure-failure.png`，以及本 run 三份 `agent-loop-checkpoints` 的 phaseAttempts/phaseDurations。

### 3.4 缺专属来源负例：构思错误放行，编剧单次占满 20 分钟

- run：`run-266b6ff4-8b0f-4989-be30-f27c2d82139a`，14:15:11 创建。
- 输入锁定承诺：同一只保温杯、同一温度计、两轮真实连续 30 分钟记录与可核对读数；明确“本次没有实验视频、照片、读数或采集能力，不允许改教程、图库或 AIGC”。
- 页面先把这段人工录入显示为“1 条来源线索”；正式 brief 实际传给构思的 `suppliedSources=[]`，所以来源标签并没有伪装成真实 sourceId。
- 构思 produce 48.215 秒、audit 19.116 秒。候选已逐项写明所有专属证据当前无来源，审计仍给 96 分 pass，理由是把缺口交给后续取得；`planningDisposition=null`。这与“核心承诺需要现有流水线无法取得的专属来源时应在构思首次审计后 `needs_source`”直接冲突。
- 系统因此继续提交编剧。编剧单次 produce 持续 1,200.502 秒后超时，OpenAI failed 从 1 增至 2；audit=0。该负例共 2 次 completed + 1 次 failed，媒体/TTS=0。
- Provider 失败后 Broker 已空闲，但 run 仍保持 `running`、页面显示“编剧第 1/3 轮：模型调用失败，可重试或调整模型”，没有重试按钮。约两分钟后正常重启 Studio，run 才变为 failed；错误变成“应用重启中断”，构思 checkpoint 虽然仍是 passed，但 UI 的 treatment/script/director stages 全部显示 pending。
- 不进行同条件重试。本负例未验证“首次识别后同角色后续 produce=0”，因为关键问题是首次构思审计没有识别；也不能用最后的 Provider timeout 冒充 `needs_source` 早停。
- 证据：`14-negative-source-locked-input.png`–`17-negative-after-refresh-390.png`、`20-negative-timeout-stuck-running.png`–`22-negative-safe-restart-persisted.png`；两份 checkpoint 保留构思 pass 与编剧 1,200.502 秒失败。

## 4. 热点、系列与短冒烟

- 热点：页面有 1 条当日缓存信号、0 条可采用候选、3 条历史候选待补来源；当前规则要求至少两个不同域名的有效原始来源。没有点击“重新刷新热点”或放宽来源。热点无法进入制作与报价，准确记为来源阻断。截图：`18-hotspot-source-block.png`。
- 系列：三个既有系列中，唯一已进入制作区的单集仍是需要专属手机两轮 15 分钟实验的旧候选；另两个系列分别被“历史成片待关联”或“历史平台不再支持/前集未解锁”阻断。没有改写历史状态或把另一个负例再次送进模型。截图：`19-series-no-viable-next-episode.png`。
- 模板与搜索：模板目录正常加载 6 个内置模板，正式模型目录可读；全局搜索“知识解释”返回对应模板并可打开。历史已通过的 CRUD 未重新制造或删除模板。截图：`12-template-search-smoke.png`。
- 响应式：抽象正例与负例运行页在 390 宽均 `clientWidth=390, scrollWidth=390`，无横向溢出。

## 5. 问题清单

### QA-R8-01（High / Functional）：可制作正例仍无法进入报价

- 复现：依次提交允许 AIGC 的抽象构图、明确非实证的 stock 城市表达、按系统建议调整的混合路线。
- 实际：分别以模板能力冲突、图库候选来源阻断、导演结构修复失败结束；三条均停在 planning。
- 预期：至少一条当前能力内的正例进入报价、精确授权和后半程。
- 已证实：三个 run 状态、checkpoint 和 Broker counters；media/TTS create 均为 0。
- 未证实：不存在“换任意题目必然成功”的结论；本轮按止损不继续换题碰运气。

### QA-R8-02（High / Functional + Performance）：缺专属来源负例未早停

- 复现：使用 3.4 的锁定真实实验输入，开始制作一次。
- 实际：构思明确列出 `suppliedSources=[]` 和全部来源缺口，审计仍 96/pass；继续到编剧并等待 20 分钟超时。
- 预期：首次构思审计 `needs_source`；构思后续 produce=0，编剧/导演/media/TTS=0。
- 已证实原因：真实 audit 把“以后可取得”当成通过理由，`planningDisposition=null`；不是 Broker 排队（queue 0）或字段 parser 失败。

### QA-R8-03（High / Functional）：失败后的模型选择没有应用到恢复

- 复现：stock run 的导演 Provider 失败后，在页面选择 GLM，再点“重试失败步骤”。
- 实际：配置 PUT 409；retry POST 200；后续 checkpoint/receipt 仍为 `gpt-5.6-sol`。
- 预期：配置保存成功并从导演阶段使用 GLM，或 UI 明确阻止 retry，而不是看似接受选择却继续旧模型。

### QA-R8-04（High / Reliability）：Provider 超时后 run 停在不可操作的 running 状态

- 复现：负例的编剧真实请求达到 20 分钟 timeout。
- 实际：Broker `active=0`、failed 已增加，Studio run 仍 `running`；页面没有它所提示的重试/换模型动作。重启 Studio 后才归为 failed。
- 预期：completed failure 被消费为稳定 failed 状态并立即显示合法动作，不依赖重启收口。

### QA-R8-05（Medium / UX + Observability）：整个 planning 的调用与耗时被最后角色覆盖

- 复现：查看 adjusted positive 失败页的“这一步为什么用了这些时间”。
- 实际：真实 14 次调用只显示 5 次；前两角色的模型时间被归为“本地处理”。“2 次自动重试”实际是结构修复，不是 Provider 自动 retry。
- 预期：节点总数与角色分项都可核对，produce/audit/结构修复/Provider retry 分开，耗时不把前序模型执行算成本地处理。

### QA-R8-06（Medium / Recovery）：重启后已通过 planning 子阶段不可见

- 复现：负例构思已 passed、编剧失败后正常重启 Studio，再查看 run。
- 实际：构思 checkpoint 保留 `status=passed`，UI planningStages 却全部 pending；失败原因改写为“应用重启中断”。
- 预期：已完成构思仍标记完成，只重做真实受影响阶段；重启不覆盖原 Provider timeout 诊断。

### QA-R8-07（Low / Race）：原任务刚完成时查询会返回 409

- 复现：运行中点击“查询原任务”，请求同时完成并切阶段。
- 实际：一次 query POST 409，页面提示“没有可查询的原模型任务”；调用计数没有增加。相同 race 在模型配置更新上另出现一次 409，但后者已单列 QA-R8-03。
- 预期：把“任务已完成/阶段已前进”当作幂等观察成功并刷新状态，不向用户报冲突。

## 6. 调用与费用账本

| 范围 | OpenAI | ZAI | 媒体/TTS现金费用 |
| --- | ---: | ---: | ---: |
| QA 开始前 | completed 0 / failed 0 | completed 0 / failed 0 | ¥0.00 |
| 抽象正例 | +6 completed | 0 | ¥0.00 |
| stock 正例 | +16 completed / +1 failed | 0 | ¥0.00 |
| 调整后正例 | +14 completed | 0 | ¥0.00 |
| 缺来源负例 | +2 completed / +1 failed | 0 | ¥0.00 |
| 热点/系列只读期间 | 0 | +1 completed；公开接口不暴露 task kind，来源未证实 | ¥0.00 |
| 最终累计 | completed 38 / failed 2 | completed 1 / failed 0 | `¥0.00 / ¥50.00` 止损线 |

- 文本与审片模型走现有 subscription，不计入媒体/TTS 现金止损。
- 没有出现媒体报价、授权金额、media taskId、TTS 任务或 unknown 付费状态；没有可确认的单笔支出。

## 7. Console、页面健康与健康分

- QA 内捕获两次产品 409：原任务完成 race；导演模型配置更新冲突。Studio 正常重启窗口内的 `ERR_CONNECTION_REFUSED/INCOMPLETE_CHUNKED_ENCODING` 是预期连接中断，单独记录，不当作常态页面错误。最终安全重启后清空 console 并重新加载，console error=0。
- 没有发现断链或 390 横向溢出；模板、导航、搜索和认证均正常。
- 观察范围健康分：`72/100`。分类：console 70、links 100、visual 100、functional 40、UX 47、performance 70、content 92、accessibility 100。该分只描述本轮访问页面，**不是生产放行分**。

Top 3 阻断：

1. 缺专属来源的核心实验承诺没有在构思阶段早停，反而多消耗一次 20 分钟失败调用。
2. 三条当前能力内正例仍没有一条到报价，媒体、TTS、渲染、双审和返工继续全部未验证。
3. 失败后模型选择与恢复状态不可靠，且节点调用/耗时说明无法对上实际 checkpoint。

## 8. 截图索引

- `01`–`02`：最终 dist 登录与首页。
- `03`–`07`：抽象正例输入、运行、390 与 `needs_user`。
- `08`–`10`：stock 正例、导演失败和最终 `needs_source`。
- `11`：调整方案预填。
- `12`：模板/全局搜索短冒烟。
- `13`：调整后正例导演结构失败。
- `14`–`17`：缺来源负例输入、开始、390 和刷新。
- `18`：热点来源不足。
- `19`：系列无可直接开工正常单集。
- `20`：负例 Provider timeout 后仍显示 running。
- `21`–`22`：Studio 重启后的失败状态与第二次安全重启持久化。

证据目录：`docs/qa/videofactory-real-local-qa-20260913-07-assets/`。

## 9. 最终结论

- **指定修复的确定性验证：完成并通过。** 正式目录/Broker 合同、空 Canon、planningDisposition 控制流和安全诊断都有 source/dist 正式测试证据。
- **本轮 QA：执行完。** 按有限样本和同根因止损结束，没有边测边改、没有盲目重试、没有付费媒体调用。
- **产品验收：未通过。** E01、E03、E04、E07 仍 blocked；E02/E05 仅部分；E06 有真实失败。没有新成片，不能宣称生产全链路完成。
- 没有 commit、push、云部署、外部发布、删除或迁移用户数据。服务最终保持健康与空闲，等待审查窗口统一处理。
