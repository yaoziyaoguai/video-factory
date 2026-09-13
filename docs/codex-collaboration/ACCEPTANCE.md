# 验收与集中验证

任务：`VF-R3-CLOSURE-20260912-01`。以下全部为目标要求，不是当前通过声明。

revision 3 补充：`PROMPT_REVISION.md` 的 PR01–PR10 并入 R03 及下面既有合同/恢复/质量检查，执行结果在 RESULT 中一并映射；不增加十个分步审计关卡。角色提示词、实际输入、审计上下文和 Broker 白名单必须同步，不能只改正文就宣布完成。

## 初始审计缺陷

将 evidence 的探针迁入正式套件，RESULT 逐项映射新测试。协议改变可更新 helper，不得反转行为断言。

| ID | 初始证据 | 修复后必须证明 | 旧验收关联 |
| --- | --- | --- | --- |
| A01 | P01 | 202→轮询完成保持原 output/trace/session；下一轮修订使用同一会话 | RC-03 |
| A02 | P02 | 同 ID 同绑定并发只执行 1 次；同 ID 异绑定仅一方受理，另一方 conflict | BR-01/06、SF-01 |
| A03 | P03 | 缺/错 kind、digest、session、store/Provider 绑定不能取回或执行；正确绑定可读 | BR-06 |
| A04 | P04 | orphan/uncertain 不假称 running；新旧记录无证据均安全停止、不重派 | BR-03、RC-08 |
| A05 | P05 | 202 后 ENOENT/ECONNREFUSED/reset/timeout/裸404 不退回未受理，POST/backup 不增加 | BR-07、RC-02/05 |
| A06 | P06 | 已核验 completed_failure 不受内部500误分类，不无限查询；质量/合同失败不乱切模型 | RC-04、UX-01 |
| A07 | P07 | 缺派生 registry 仍能取回结果、恢复同一会话；不重跑原任务 | BR-05、RC-03 |
| A08 | P08 | rejected/conflict/uncertain 对任意错误原因均禁止 fallback；trace parser 接受合法新 stage | SF-01、UX-01 |
| A09 | P09 | 最大合法用户偏好完整传给模型；所有来源/避开/定位信息保留，超限显式拒绝 | TC-01/03 |
| A10 | P10 | 已受理却丢 POST 回包后查询原任务成功；executor=1，原 POST=1 | RC-02 |
| A11 | P11 | 被替换的 response requestId/digest/Provider/contract 不被消费，报告 conflict | BR-06、RC-03 |
| A12 | P12 | 完成写失败不 unhandled rejection 崩溃，不伪完成/重放；派生索引失败不丢已落盘结果 | BR-01/04、RC-08 |

## 新增缺口测试与安全门

### G01：真实合同生产者与版本保护

- 捕获正式 topic、treatment、script、director、role-audit 适配器的实际请求，而非只测试手写 payload。
- 验证初始/修订/结构纠正各变体、实际联合规划字段；将捕获请求交给正式 Broker parser/validator。
- topic 全部最大合法字段完整传递；6000/6001 边界、未知字段、nonce 身份隔离。
- 输入合同变化导致 descriptor digest 变化；health、expected digest 与两端边界一致；mismatch 在 executor 前拒绝。
- 空模型候选、混合旧候选、规则回退仍如实展示本轮 receipt。

### G02：确定性并发与单 owner

- barrier 强制多个相同提交同时争用：默认并发与 concurrency>1 均验证 executor=1，重复完成查询增量=0。
- 同 ID 不同 payload/kind/session/contract 的交错提交必须 conflict，不能覆盖既有记录。
- 两个独立子进程、不同 socket、同 idempotency 目录：第二 owner 拒绝启动，不修改活跃 owner 的记录/socket。
- 当前 owner 重启后的旧 accepted 不重派；故障前已经完成的记录仍可稳定读出。

### G03：真实 role/checkpoint 跨进程恢复

使用正式 Broker 子进程 + 真 socket + 真文件记录 + 正式 client/fallback/role loop/checkpoint，仅 executor 替身隔离外部副作用：

1. checkpoint 已保存实际 pending envelope/digest/路由后才允许 POST；checkpoint 保存失败时 POST=0。
2. 丢202回包、丢完成回包、completed 后 client crash、保存 output 前后 crash，重建客户端/role 后均恢复原成果。
3. query 不增加 generation、phaseAttempts、sessionRebuilds、fallback 或质量迭代次数；已 passed treatment 不重做。
4. sessionAffinity Map 清空、候选顺序变化后仍查询原 Provider；不得以新默认模型偷换原任务。
5. 确证 not_accepted 的有界新尝试可成功，冲突/未知不可；不要为了安全把所有正常恢复/backup 功能永久禁用。
6. 旧记录绑定不可证明时有可理解停顿，不用当前 prompt 拼造旧请求。四条历史失败 run 的特定400原因可作背景，回归用通用等价 fixture，不写 runId 特判。

### G04：故障矩阵与后台生命周期

- 查询 reset/ENOENT/ECONNREFUSED/超时/半包/非法JSON/错误信封/5xx/裸404/错误storeId。
- 缺失、损坏、不可写记录；accepted 落盘失败；completed 落盘失败；仅 registry 落盘失败。
- queue 拒绝/queued取消不等于 Provider 执行后失败。not_accepted 保留有绑定且不可再执行的终结证据。
- graceful shutdown 等待完成落盘，deadline 后如实 unknown；硬 crash 重启不重复 executor。
- 每个故障必须断言任务事实、返回动作、实际调用计数，不只断言 throws 或文本匹配。

### G05：服务端动作、暂停与用户界面

- `taskRecovery/allowedActions` 由服务器事实生成；直接调用被禁用 API 也应被拒绝。
- “查询原任务”在 queued/running/unknown/completed/query-failure 下都不调用模型、不解暂停、不生成授权。
- “取回并继续”仅消费匹配版本的完成结果；连点、并发两次、刷新、重启不造成双推进。
- 用户暂停后结果到达仍保持暂停；必须显式继续。用户改方案后旧结果不能污染新计划。
- 无已知状态时不臆测未扣费/已失败，不把订阅文本查询引向现金核账。
- 1440/390 宽度、键盘焦点、loading/错误/恢复状态组件测试和浏览器验证。

### G06：既有制作和费用不变量

无需真实重复花费，使用既有正式测试入口做故障注入：

- 未授权媒体 create=0；授权范围变化需重新确认；unknown 不解锁新购买。
- 没有素材就停在对应节点，绝不用说明卡伪成功。
- 同一 executable plan 的时间轴、音画、产物绑定一致；复用不变母片。
- 双审互不可见、同 snapshot、不同实际模型；单分支补审时 media/voice/render 增量=0。
- 局部返工只影响真实依赖闭包；媒体证据不完整先补证，不自动新增购买。
- TTS 自动执行/后台记账、无全局硬费用上限等既定产品规则保持。

### G07：正式构建和全量检查

先聚焦再集中全量，不能只复跑本包12个小测试。使用同一 Node 环境完成构建/测试，避免 better-sqlite3 ABI 混用。若遇 ABI 错误，记录实际版本、在隔离测试依赖环境恢复；不删除真实数据库或换掉生产依赖来假过。

从仓库根运行并记录退出码：

```sh
npm run build:pipeline
npm run test:ts
npm run test:broker
npm run studio:test
npm run typecheck
npm run build
npm run test:package
git diff --check
```

Python 使用项目现有虚拟环境与正式 unittest 入口：`PYTHONPATH=src .venv/bin/python -m unittest discover -s tests`，先核对实际解释器。执行 revision 1 已报告 131/131、exit 0；缺少 pytest 本身不是产品失败或付费阻断，无需为此安装测试框架。此前本资料要求必须 pytest 是审查方验收工具选择过重，现更正；不降低已有测试覆盖。未修改 Python 也须保留成片链的回归证据。

独立 Broker release smoke 仅在临时目录执行，不上云：从正式 build 复制现有部署应包含的文件，启动受控 executor/health 检查，确保没有未打包的跨应用依赖。

如果旧孤儿测试未被 package script 收录，不能假装无此文件：核对并运行与本次相关的遗留失败（报告提到的 editorial-decision 等），记录是否已覆盖、是否仍失败及原因。未修的失败不能写“全量无问题”。

### G08：真实环境启动前安全门

只有 A01–A12、G01–G07 的相关安全/合同/恢复回归有证据通过，才进入新的付费测试。不是每个门额外外部审计，是执行者自己核对确定性结果。

先确认旧本地服务的 PID/工作目录/构建和 in-flight task，再正常停止并重建正式服务；不能因重启把已提交任务遗忘，也不能删旧记录让按钮恢复。真实 Broker、workspace 和 Provider 身份须实测；现有 qa-local 登录方式从项目正式配置加载，不展示凭据。

## 真实本地 E2E：一轮尽量覆盖后集中修复

用 QA 与浏览器 Skill 的当前说明操作，保留截图、API/运行记录和真实媒体证据。不能挂 fake broker、不能修改数据库让门禁通过、不能手工制造通过审片。

| ID | 场景 | 必须证据 |
| --- | --- | --- |
| E01 | 热点、系列本集、自有想法三个入口分别到真实规划/方案/报价 | 真实模型 trace、用户选择/补充要求、共享后段的实际 run；来源不足如实处理 |
| E02 | 报价、拒绝追加/调整方案/暂不继续、暂停与显式恢复 | 页面点击与服务端状态；未同意时媒体 create=0，不为测试暗改状态 |
| E03 | 至少一条代表性制作真实完成媒体、配音、剪辑/渲染 | 当前报价、精确授权、Provider taskId、账本、真实视频；其它入口可停报价避免重复花费 |
| E04 | 两个真实模型独立审片并取回结果 | 两个实际 provider/model、同 evidence SHA、独立意见；质量不通过不能人为盖章 |
| E05 | 用户打回后按审片建议预填相关节点、局部返工、复用未变成果 | 修改前后 plan/affected set/产物与调用计数；必要新媒体先看报价，避免全片重买 |
| E06 | 刷新、client/Studio 重启及安全可控的 Broker 恢复；1440/390可用 | 已证明安全的恢复路径真实点击；不故意杀掉真实付费 Provider 来测试重复扣费 |
| E07 | 成片技术与创作质量、各状态文字可理解 | 逐段视频/音频检查、帧数/实际长度/同步、开头承诺/推进/结尾兑现、视觉一致性与文字干扰记录 |

没有固定24秒要求，实际时长必须对应当前时间轴，所有片段有真实画面，不能用错误抽样拼图判断尾部黑屏。素材质量评价必须看成片，不依赖模型分数。

每笔媒体调用前记录预估与范围，调用后核对真实回执与账本。合理小额授权不是开放式烧钱许可；重复执行防护用隔离计数测试，不通过故意重复购买来证明。

若这一轮 E2E 被环境或产品错误阻断：其余可测试路径继续完成，报告具体根因、已排除原因、未覆盖范围。优先修本任务同根因问题；独立大范围缺口需明确提请决定。不能把未走到的媒体/双审/返工记为 PASS。

## 最终交付门槛

RESULT 必须包含：

1. 相对 BASELINE 的本轮文件变化，不把原 A/B/C 修改算本轮贡献。
2. A01–A12、G01–G08、E01–E07 逐项证据与真实状态；原始红灯到正式绿灯的测试映射。
3. 完整命令、退出状态、失败/skip解释，最后构建与当前运行服务相符的证据。
4. 本轮真实 QA 报告路径、成片/审片/返工记录、实际支出和复用情况，不写密钥。
5. 未验证、风险和阻塞，不偷改报告为全通过；未 commit/push/云端操作声明。

全部满足后设 READY_FOR_REVIEW，停止修改，由强模型窗口统一审查。没有证据的“应该可以”不算验收。
