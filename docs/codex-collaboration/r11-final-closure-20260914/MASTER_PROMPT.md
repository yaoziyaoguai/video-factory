# R11 剩余问题收口：修复执行入口

你是实现和真实本地 QA 执行者。请直接完成本包范围，不只回复计划、不重新审计整个项目。仓库实际路径：`/Users/jinkun.wang/work_space/veidofactory`。

## 必须完整读取

本目录绝对路径：`/Users/jinkun.wang/work_space/veidofactory/docs/codex-collaboration/r11-final-closure-20260914`。

按序读 `AUDIT.md` → `IMPLEMENTATION.md` → `VALIDATION.md` → `REAL_QA.md` → `BASELINE.json`；`evidence/probe-before.json` 是本次只读诊断结果，`evidence/probe.mjs` 是可运行回放，不是产品实现或真实模型测试。

然后读：

- `docs/codex-collaboration/RESULT.md` 最新 R11 记录与本次审计记录。
- `docs/qa/videofactory-real-local-qa-20260914-r11-repair.md` 全文及其 `-assets/final-evidence.json`。
- `docs/codex-collaboration/revision11/implementation/01_PRODUCT_AND_UX.md`、`02_TECHNICAL_DESIGN.md`、`05_ACCEPTANCE.md`。
- `docs/codex-collaboration/r11-qa-repair-20260914/VALIDATION_AND_QA.md` 的既有回归矩阵。旧包已经实现的部分是回归基线，不重新做全部11项。

本包是最新剩余范围与执行顺序；原 R11 用户确认、真实性、时间轴、复用、授权、双审合同仍有效。`CONTEXT.md` 中“绑定推荐模板”等过时叙述不能覆盖 R11 模板停用决定。资料行号只导航，修改前阅读当前函数及调用者。

## 接管事实与范围

HEAD 为 `b36ebac3189cf574b8e437cbe16eb9d0b228a177`；分支 `codex/final-dual-review-cloud-acceptance`。大量 dirty 是用户已做成果，不是可清理垃圾。先核对当前 HEAD/status 与 BASELINE 的325项文件 SHA；差异有解释即可保留，不恢复旧版本、不覆盖其它窗口成果。

集中完成 K1–K6：分镜语义修正边界、图库调整基线及可讨论停止、热点事实/表达分工、请求归属与耗时、终态完整刷新、手机讨论遮挡。目标是通用生产链可用，不是硬编码某条城市短片成功。

工作顺序：建立各类失败证据 → 集中修复 → 聚焦与全量串行回归/正式构建 → 自查实际差异 → **无需等用户，直接启动最终构建的真实本地环境，按 REAL_QA.md 做浏览器和全链 E2E** → 集中记录。只有阻止其它测试继续的缺陷先处理；不一小项一审、不一小项一部署。

## 不得改变的决定

- 三入口；导演方案、脚本、分镜三个用户讨论与确认点；用户可无限轮讨论，系统单次自动修正有界。
- 用户明确要求优先；自动建议不变硬要求。模板不进入新制作，但 CRUD/历史保留；不增加默认音效或说明卡兜底。
- 真实缺料不能生成冒充；示意可用用户允许的生成/图库/复用。质量优先，之后省钱；购买绑定最新已确认计划和报价。
- 模型及思考强度不降级、不缩上下文掩盖慢、不靠加大deadline解决。不增加框架、数据库、独立核账系统或新的模型监工。
- 不清 checkpoint、未知任务或历史；不换 run/题目刷成功；不手改状态、确认、素材编号、审计分数。控制测试可注入外部 transport，真实 QA 禁 fake Broker/素材/模型。

## 权限和费用

本地修复、编译、测试、真实本地部署/正常重启和 QA 已授权。复用指定本地服务配置，凭据只传给需要的进程，不回显、不复制进报告、不扫全机秘密。

沿用本轮 R11 **累计人民币50元** 测试授权，不新开预算。上一轮确定现金0、在途/未知现金0，但付款前重新核对实际账本及本轮其它请求。范围与报价合理且总暴露不超额时自己点击确认；TTS自动执行也要预留费用。订阅文本不另算虚构现金账单。未知任务不当失败重投。

不 commit、不 push、不云部署、不外部发布、不迁移/删除用户数据、不升级工具、不自动发 Oracle 或外传资料。只有新登录、超预算、无法确定现金暴露、破坏性操作、实质产品/架构范围变化才请求用户。

## 记录与结束

只向统一 `docs/codex-collaboration/RESULT.md` 追加进展、原因、测试退出码、费用和未验证项；真实 QA 新报告使用 `docs/qa/videofactory-real-local-qa-20260914-r11-closure.md`，若已存在则追加本次段落，不覆盖。不要重写 TASK/REVIEW 或本包来降低标准。

一次条件变化后的受控复验仍失败时停止该链，记录实际request/原因/证据，继续其它独立可测项；不能停在“编译通过，等用户允许测试”。最终明确 `CODE_VALIDATED` 是否成立、QA逐项 PASS/FAIL/BLOCKED/NOT_VERIFIED、产品是否通过。无成片/同片双真实视觉报告/局部返工证据，必须写 PRODUCT_NOT_ACCEPTED。
