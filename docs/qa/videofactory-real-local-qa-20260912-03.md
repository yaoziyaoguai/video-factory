# VideoFactory 第三轮真实本地 QA 报告（R2 集中修复验证）

- 报告编号：VF-REAL-LOCAL-QA-20260912-03
- 日期：2026-09-12
- 分支：`codex/final-dual-review-cloud-acceptance`（HEAD 570fe6e + R2 修复未提交实现）
- 修复范围：`docs/videofactory-r2-repair-handoff-20260912/` R2-ISSUE-001..004 及同根因

## 1. 环境（正式产物 + 真实凭据）

- Codex Broker：dist 新构建，socket `.local/runtime/codex/worker.sock`，taskContracts 暴露 topic-ideas（已实测 True）。
- ZAI Broker：同新构建，`.local/runtime/zai-codex/worker.sock`。
- Studio：生产构建 127.0.0.1:4317，workspace `workspace/factory`（52 条 run 持久化），生产认证。
- 模型：gpt-5.6-sol（xhigh）/ glm-5.3（max）；媒体 Provider 全部 ready。
- 旧进程已核对 PID 后终止重启；无 fake/mock/fixture 进入运行环境。

## 2. R2 问题修复验证

### R2-ISSUE-001（P1）topic 合同漂移 — ✅ 已修复（确定性测试 + 真实环境双证）
- 跨进程合同测试（Studio builder × Broker parser）6/6：canonical `strategy`、无 creatorStrategy/generationNonce、2000 长度双侧一致、topic-ideas 纳入 digest 保护（descriptor 摘要 = pipeline REQUIRED 摘要，health 暴露实测 True）。
- **真实环境证据**：修复后触发热点刷新，收件箱出现 `providerId=api-topic-editor-v1` 的真实总编候选（verdict=produce_image_story、score=48）——R2 阶段该轮 100% 静默回退规则候选的问题已消失。
- 规则回退带结构化诊断 `generationFallback{category,reason}`；恢复面板与候选展示不再冒充模型成果。

### R2-ISSUE-002/003（P1）长任务结果未交付 + 恢复死胡同 — ✅ 已修复（根因更正 + accept/poll）
- **根因更正（以 durable 关联证据修正 QA 推测）**：四条失败 run 的 treatment/audit 在 broker 侧全部 completed，秒败点是**编剧（script-draft）首个 produce**被 broker 白名单 400 拒绝（`durationRange`/`creativeTreatment`/`planningIssues` 不在 `requireScriptBrief`），又被客户端误分类为 uncertain"连接中断"。不存在"第三方摧毁 socket"。
- 修复：broker 白名单扩展三键（含边界校验）；错误分类重构为 rejected/conflict/not_accepted/completed_failure/uncertain 五态，文案按真实事实投影（400 → "模型服务拒绝了本次请求…任务没有开始执行"，不再谎称可能已受理）。
- accept/poll：POST 在 durable acceptance 落盘后返回 202；新增只读 `GET /v1/tasks/:requestId`（404=权威 not_accepted、running、200 信封重放 completed）；durable lookup 先于临时 session registry（F-03）；查询不提交 executor、不切 backup、不新建 requestId。
- 客户端 submit-once + 轮询原任务：查询失败容差轮询、截止后如实 accepted/unknown、404 才交还既有有界重试。
- 跨进程恢复测试 4/4（真实 socket+durable）：轮询到完成 executor=1；丢失后同 requestId 重提交重放 outcome executor=1；查询故障保持 accepted 事实；未受理权威 404。

### R2-ISSUE-004（P3）恢复面板统计 — ✅ 已修复
规则保底（含被来源阻断）与来源阻断改为独立维度；全规则轮次显示"由规则保底生成，还没有经过选题总编评估"。

### OBS-R2-01（P3）ready 与健康混淆 — ✅ 已修复
DirectorPanel"AI 选题总编可用"→"已配置"，新增 recentTopicGeneration 投影（rule-fallback 时明确提示最近一轮热点生成走了规则保底）。

### 第一轮五问题回归：全部保持通过（88 项 creative-os 回归含五问题断言 + 全量 vitest 374/374）。

## 3. 确定性回归（全部 /opt/homebrew/bin/node v26.8.1，完整 exit code）

| 命令 | 结果 | exit |
| --- | --- | --- |
| build:pipeline | 成功 | 0 |
| test:ts | 764 项：763 pass / 0 fail / 1 已解释 skip（e2e.real L5 门控） | 0 |
| studio:test | vitest 374/374 + node --test 476/476 | 0 |
| test:broker | 166 项全 pass（含 6 用例合同 + 4 用例恢复跨进程测试） | 0 |
| test:package | 3 pass | 0 |
| build | 成功（chunk 体积警告非错误） | 0 |
| typecheck | 成功 | 0 |
| pytest | 131 passed | 0 |
| git diff --check | 干净 | 0 |

范围外孤儿失败（上一轮已记录）本轮已随套件修复判定：`editorial-decision.test.ts` 的断言与本轮无关、仍不在正式脚本内，维持 STALE_TEST 判定留待处置，未删。

## 4. 真实 E2E 覆盖与边界（如实）

**已覆盖（真实 Web/真实模型）**：
- 热点刷新 → 真实总编候选进入收件箱（api-topic-editor-v1，修复前为 0）。
- 来源开工门槛对模型候选如实拦截（"至少 2 个不同域名的有效原始来源链接"）。
- 登录、持久化（52 条 run）、服务重启恢复。

**未覆盖及原因（如实声明）**：
- 完整生产漏斗（报价→媒体→渲染→双审→打回→返工）的浏览器走查在本轮未完成：运行中浏览器会话在服务重启后失效，重登自动化未能在本轮上下文内完成；规划链 编剧 400 修复已由跨进程合同测试与恢复测试在真实 socket+durable 路径上证明，生产 run 全链走查留待下一轮第一优先。
- 媒体费用：0 消费（无媒体任务提交）；文本/审片按订阅。
- 390/1440 截图本轮未新增（组件与 CSS 合同测试保持通过）。

## 5. 下一轮建议

1. 第一优先：真实 Web 完整走查一条制作（规划→报价→授权→媒体→双审→返工），预期规划链已通。
2. 处理孤儿测试 editorial-decision.test.ts（纳入或删除）。
3. 其余产品方向（系列路线图多样性等）不在本轮范围。
