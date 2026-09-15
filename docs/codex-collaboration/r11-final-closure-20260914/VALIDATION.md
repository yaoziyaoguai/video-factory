# 确定性验收包

先红后绿，最终一次集中验收。`probe-before.json`不是“测试通过”，而是旧缺陷被复现。不要修改它来迎合新实现；新输出另存。所有控制测试禁止访问真实模型/媒体服务；替换外部边界，保留正式parser、executor、Broker、client、role loop、SQLite、RunStore、Studio服务。

## 必须补的行为测试

| ID | 最低失败→成功序列 | 必须同时保护 |
| --- | --- | --- |
| C01 K1 | 合法producer1次；schema合法但scene重复→一次有针对修正→合法待确认；OpenAI和ZAI两真实executor受控transport分别跑 | 非法候选不作成功；不改已确认脚本；用户确认前不独审/不买媒体 |
| C02 K1 | 原错误→同样错误、schema错误→语义错误、超大/截断/invalid JSON、错误引用/漏场景；终态均明确且有上界 | schema和semantic共用单请求上限；失败计数可读，不fallback洗次数；修正成功不证明成片质量 |
| C03 K1/K4 | acceptance后、第二attempt前后崩溃/断连；同IDPOST重放和GET观察；未知不自动再执行 | durable原请求身份、原有租约/白名单/诊断脱敏；deadline不按修正重置；真实双审失败不能被改pass |
| C04 K2 | 5场景，图库1/2不足→模型改1/2生成且其余保留；再模拟独立4不足→只改4，捕获正式下一producer输入含previousPlan/digest/issues/history | 输入链必须经过Broker parser；换scene数、位置、题材后仍适用；越界改变1/2必须拒绝，不能题目特判 |
| C05 K2 | 连续图库无改善、但合法当前方案存在→director_review waiting_user；刷新/重启看同稿，可解释/修改/返回script；原已halt的R11 run显式恢复同样可达 | treatment/script SHA/确认不重做；没有素材就disabled并服务端拒绝confirm；真实evidence仍不能生成冒充 |
| C06 K2 | director讨论改路由/动作→旧ranking失效→按指纹重搜/重排/整合→显示新最终稿→重新确认才报价 | explain/propose未采用0重搜；无改动确认不重复整合；旧quote/旧confirmation不能用；当前issues已消解，历史保留 |
| C07 K3 | 原6ideas回放和跨题材同义对照：同一创作标签有无引号/英文/结构数量，宿主接受决策不因此改变 | 不要求6都推荐；坏signal/paragraph/readStatus拒绝；图注和事实断言由独审区分 |
| C08 K3 | 正文有而标题没有的事实→完整独审上下文包含正文；虚构数字/因果/来源、传闻转结论→独审repair或来源门拒绝 | 包括title/hook/visualPlan而非只facts；高风险规则改写不冒充已审；未知/缺正文可发散不等于可以制作事实片 |
| C09 K3 | 模型合法空结果、6条全被无效引用过滤、模型执行失败规则回退三种UI/receipt不同 | 可理解拒绝原因、不回填未经审查的推荐、不能向UI暴露私密正文/完整prompt |
| C10 K4 | requestA失败→operationB恢复新requestB→只B属本次；重复checkpoint/不同快照/重启/查询不增次数 | failed执行保留；not_accepted0模型；unknown单列；历史缺归属诚实；讨论与生产用同口径 |
| C11 K4 | 可控时钟排队20秒、模型30秒、本地2秒、人工等待60秒；一次Broker内2attempt | UI不显示112秒模型耗时；Broker任务1/模型执行2区别；重叠不叠加，缺值不写0；失败attempt也计入 |
| C12 K5 | 完整detail→同revision简略failed事件→停止SSE→最终GET；旧GET晚于新revision到达；快速换run | 终态具体错误无需刷新可见；旧snapshot不覆盖新run；不保留旧授权/稿身份；GET失败可重读但0生成 |
| C13 K5 | generic retry、creative command、pause/resume、配置保存分别走终态获取 | 用户输入不丢焦点/不被轮询覆盖，404区分暂不可读与真实不存在 |
| C14 K6 | 讨论短/长输入、方案/讨论tab、撤销disabled/enabled、中文IME、输入后刷新；桌面和手机 | DOM可点击性由真实浏览器补证；单纯组件测试无layout不得标视觉PASS |
| C15 跨边界 | 正式Studio→Pipeline→真实SQLite/RunStore→socket Broker→注入外部模型：三确认→报价；媒体create调用计数 | 中间实际产物接下游，禁止手填confirmed host；0授权0媒体；局部新报价不买未受影响素材 |

C01–C15与原D11-02/03/07/10/13/16/17/23/29/30/32/33/35/39/40/41/43/44/45相衔接，不取代原全量回归。声音、模板暂停、有效指令撤销、budgetIntention、队列503、schema投影和未知任务保护均保留既有测试。

## 文件落点

优先扩展当前文件，不新建平行测试框架：

- `apps/codex-broker/test/{codex-executor,zai-code-plan-executor,task-definitions,broker-server,task-lifecycle-v3.cross}.test.ts`。
- `packages/production-pipeline/test/{role-agent-loop,creative-planning,creative-review,codex-visual-director,production-planning-closure,production-authorization}.test.ts`。
- `apps/studio/test/{trend-opportunity-agent,production-planning-stages,production-planning-editing,text-task-production-recovery,client,creative-discussion-panel}.test.ts[x]`（按实际扩展名核对）。
- 新跨边界文件需收录package script；Studio部分Node测试采用显式列表，不允许孤儿测试。source与dist都测试新增DTO完整传递，hash一致不足以证明字段未丢。

本次只读探针可先运行：

```sh
node --import tsx docs/codex-collaboration/r11-final-closure-20260914/evidence/probe.mjs
```

它读原本地记录并在内存导出私有函数；不作为长期架构/产品API。引用的旧runtime缺失时如实记录，使用明确脱敏的正式测试夹具建立同一失败条件，不从别的run猜证据。修复后私有函数删除导致探针失效不代表产品回归，正式行为tests才是验收；保留本次原始证据。

## 运行方式

Node采用本机已工作的 `/opt/homebrew/bin/node` 对应运行时，先确认 `node --version` 和原better-sqlite3 ABI。不要为跑测试换模型/升级工具；依赖损坏需先解释具体错误。

聚焦Node测试：仓库根运行 `node --test --test-concurrency=1 --import tsx <明确文件列表>`；组件在 `apps/studio` 运行 `npx --no-install vitest run <明确组件测试文件> --reporter=dot`。workspace依赖指向dist时先构建pipeline，不能测旧产物。

最终从仓库根逐条串行：

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

新增K1/K2合同与C15组合也必须有source/dist运行，按现有方式加测试，不修改旧证据为新通过。build脚本会清写同一dist，不能并行。全部逐条跑过后不用再跑npm test重复整套。每条保存完整log、起止、退出码；管道保留原测试退出码。

## 进入真实QA的条件

C01–C15控制/协议部分通过，全量回归通过，最终dist与本次源码摘要一致，diff无越权。既有 `e2e.real.test.ts` 默认skip明确解释，不能代替真实片；本次有关的新skip或失败不得放行。纯真实外部语义/布局/声音结果交下一阶段，不伪装已有确定性证明。

达标后直接进入REAL_QA，不等用户。若QA期间需要同范围阻断修正，集中收集可测项后再修，最终修改后必须再构建并跑受影响回归，不能继续测旧dist。
