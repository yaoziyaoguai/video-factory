# B4 单阶段执行卡：joint planning 正式接入收口

任务编号：`VF-RECOVERY-B4`

执行者：Claude Code + 用户配置的 GLM 5.3 Flash，使用实际可用的最高 thinking。审计者：主 Codex + Oracle Web。一次只完成 B4，完成后停止。

## 1. 用户可观察目标

新制作和新返工版本只运行一条 joint planning 路径。导演构思、编剧、分镜和素材可得性共享同一方案；刷新、重启、换模型或编辑不会悄悄使用旧结果。用户看到的阶段状态真实，历史 run 仍可按原拓扑恢复。planning 不调用付费媒体 Provider。

## 2. 当前已确认事实

- B4 pipeline 聚焦 144/144；Studio 24/29；root typecheck 失败。
- joint/legacy 可见拓扑已经互斥，joint 失败会抛错。
- 新 derivative 已标 `joint-v1`；旧 persisted run 不会被 parser 默认迁移。
- script/director 已收到 `creativeTreatment` 和 `planningIssues`。
- seed 已将 carried provenance/compatibility 和 artifact 一起保存。
- treatment 已正式注册，executable IDs 已部分重绑。
- 当前仍有 7 个阻断根因和 1 个 provenance 错误；详见 `oracle/results/B4_ORACLE_TRANSCRIPT.md`。

不得回退上述已修行为。

## 3. 前置条件

1. 完整读取 `MASTER_PROMPT.md`、`CURRENT_STATE.md`、`AUTHORITATIVE_DECISIONS.md`、`ORACLE_SYNTHESIS.md` 和 B4 Oracle transcript。
2. 检查当前 `git status --short --branch`、HEAD、untracked；记录与本包基线的差异。
3. 读取下列完整源码而非只看 diff：pipeline、runner、run-store、planning/store/treatment/executable plan、角色 adapters/ranker/Broker、Python inventory consumer、Studio 编辑纵向链和相关测试。
4. 不修改 A 的产品语义；运行 B4 前先保证 `npm run build:pipeline` 可执行。

## 4. 允许修改范围

按实际 symbol 最小修改：

- `packages/production-pipeline/src/production-pipeline.ts`
- `creative-planning.ts`、`creative-planning-store.ts`
- `creative-treatment.ts`、`codex-creative-treatment.ts`
- `executable-production-plan.ts`、`contracts.ts`、必要的现有 timeline/artifact helper
- 当前角色 adapters、`asset-semantic-ranker.ts`、`codex-chat.ts`
- `packages/workflow-core/src/workflow-runner.ts`、`types.ts` 和 `run-store.ts`，仅用于既有 lease/CAS/正式 artifact 接受的窄接缝
- `python-worker-client.ts`、现有 Python stock/inventory/materialization 边界
- Studio `app.ts`、`studio-service.ts`、`production-studio.ts`、`shared/api.ts`、client API、`NodeWorkspace.tsx`、`PlanningStagesPanel.tsx`
- 直接对应的 B4 tests/fixtures

若某个文件不在此列表但真实调用链必须修改，先在 `JOURNAL.md` 说明 symbol、原因和为何仍属于 B4；不得顺手扩到 B5/C1/C2。

## 5. Non-goals

- 不修改 B5 媒体返工策略、C1 金额/授权算法、C2 报价/三动作 UI、C3-C6。
- 不重写整个 `production-pipeline.ts`。
- 不引入第二工作流、Redis、微服务、新业务数据库或通用版本平台。
- 不在 planning graph 调用媒体 create。
- 不用 legacy fallback、说明卡、弱化 revision、删除 treatment artifact 或修改旧 expected 数字掩盖失败。
- 不改 historical run 的 topology 或继承其付费权限到新 run。

## 6. 必须先建立的失败证据

测试名称可以遵循项目现有命名，但行为必须覆盖：

### B4-R1：编辑并发纵向链

- 两客户端都读 revision R/input V；A 保存成功，B 用原 R/V 保存必须 409。
- 两请求都通过 Studio 预检查后，在进入 pipeline 持锁点前 barrier；第二个必须在持锁点重新校验并失败。
- 保存中的 UI 草稿绑定打开编辑器时的 R/V，props 后台更新不能替换基线。
- 拒绝后 run、graph input、artifacts、授权状态不变。

### B4-R2：真实请求、identity 和 provenance

- recording Broker 捕获 treatment/script/director/rank 最终请求，不只检查 port 参数。
- treatment 接收适用的用户/系列承诺和 reference grammar；grammar 是风格/结构参考，不冒充事实证据。
- script/director 接收当前 treatment/issues。
- 只更换 ranker provider/model/contract 会失效 rank，不重放 completed graph 的旧排序。
- provider ID 与 model ID 明确不同；首次、fallback、seed/recovery 的正式 treatment provenance 均正确。

### B4-R3：rank 意图、inventory 和 outputs

- query/provider/candidate IDs 不变，但当前主体/动作/真实性要求变化：不重搜，必须用新语义 rerank，checkpoint identity 变化。
- 完全未变对照组不 rerank。
- private inventory 与 public report 使用不同内容和路径，真实离线 materialization 消费 private inventory。
- joint/legacy 选择只在一个 `planningOutputs` 投影中出现；消费者不再各自判断。

### B4-R4：正式发布和 crash

使用真实子进程、SQLite saver、FileRunStore/runner，不能用 throw 代替 kill：

- graph 完成、formal registry 未接受前退出。
- prepared files/部分登记后退出。
- run 已接受正式 output/commit identity、graph 尚未写结束标记时退出。
- seed checkpoint 成功、history 尚未写时退出，fallback provider/model provenance 仍保留。

恢复后已完成角色调用数不增加，正式 artifact 不重复，只有一个 current accepted result。

### B4-R5：artifact closure 和 DTO

- executable 内 treatment/script/director/candidate/rank 引用唯一解析到当前 run 当前 output version 的正式 artifact，SHA/父关系匹配。
- 缺失、跨 run、旧版、重复或篡改引用在 quote/worker 前 fail closed。
- stage 正在重跑且旧 artifact 仍在时显示 running；publication 失败不能显示全部 completed。
- 未知实际模型显示未知，不用配置默认值冒充。

## 7. 推荐实现顺序

### S1. 修编辑并发，不改线上安全合同

将 `expectedRunRevision`/`expectedVersionId` 从浏览器打开草稿时的基线贯穿 HTTP parser、service、pipeline 到真实 lease/CAS 修改点。在 no-op 返回和写入前都复核。分离“编辑草稿输入类型”和“完整 wire DTO”。

同步旧 tests/fixtures：合法请求读取真实 tokens；非法 stage 与 node/stage 配对分别测试；treatment 正式 artifact 的旧空断言改为唯一正式 artifact，并同步 actions。不得把并发字段改回可选。

### S2. 统一角色 request/compatibility/provenance

为 treatment/script/director/rank 各构造一份规范化真实请求；由该请求与明确的 producer/model/prompt/schema/rule versions 派生 checkpoint 与 stage compatibility。ranker 进入 stage identity。

补 treatment 的适用承诺和 grammar 输入；修正式 artifact 的 provider/model 字段。实际来源缺失时显式 unknown，不能用首选配置填充。

### S3. 修 rank 当前语义、inventory 和单一输出投影

保留候选池时，从当前 script/director 要求重建排序输入；rank checkpoint 使用该真实请求。保存并校验 private inventory，public report 只用于展示/语义结果；实际 materialization 消费 inventory。

建立一个兼容投影同时读取 joint/legacy；assets/voice/render/review 只消费投影，不散落 topology 判断。无图库不制造候选/库存文件。

### S4. 收口正式发布和引用闭包

沿用现有存储，不做分布式事务。区分 prepared 与 accepted；在同一既有 lease/CAS 的 run 保存边界接受正式 registry、current planning output version 和 commit identity。外部 commit 文件单独存在不等于接受。

plan 在正式 IDs 重绑后定稿并计算 SHA；quote/worker 前验证内部引用闭包。对历史 run 保持显式兼容，当前 joint 规则不放松。

### S5. 修真实 stage DTO、类型和测试

状态优先级必须来自当前 cursor/current applicable artifacts/formal publication，不以任意旧 artifact 存在作为 completed。同步正式 Studio 类型、fixtures 和重复 JSX 属性。

### S6. 集中验证后停止

先聚焦、再 typecheck、再共享回归。把 B5/C1/C2 的已知红项单列，不顺手修改；任何新增 B4 回归阻断完成。

## 8. 必须运行的检查

根据当前 package scripts 确认命令存在后，串行执行：

```bash
cd /Users/jinkun.wang/work_space/veidofactory

npm run build:pipeline

node --test --test-concurrency=1 --import tsx \
  packages/production-pipeline/test/creative-planning-store.test.ts \
  packages/production-pipeline/test/creative-planning.test.ts \
  packages/production-pipeline/test/creative-treatment.test.ts \
  packages/production-pipeline/test/contracts.test.ts \
  packages/production-pipeline/test/executable-production-plan.test.ts

node --test --test-concurrency=1 --import tsx \
  packages/production-pipeline/test/production-planning-closure.test.ts \
  packages/production-pipeline/test/production-pipeline-reference-grammar.test.ts \
  packages/production-pipeline/test/production-pipeline-preflight.test.ts \
  packages/production-pipeline/test/run-store.test.ts \
  packages/workflow-core/test/workflow-runner.test.ts

node --test --test-concurrency=1 --import tsx \
  apps/studio/test/production-planning-editing.test.ts \
  apps/studio/test/production-planning-stages.test.ts \
  apps/studio/test/api-contract.test.ts \
  apps/studio/test/node-workspace.test.tsx \
  apps/studio/test/client.test.tsx

npm run typecheck
git diff --check
```

进程恢复测试可新增一个按项目命名的 B4 publication test，并必须纳入标准 test script/CI；命令以实际文件名记录。

## 9. 对应验收

- `P02`、`P03`、`P04`、`P05`、`P06`、`P07`
- B4 专项：唯一 topology、rank identity、formal artifact closure、真实 stale edit、inventory consumption、history/new derivative 边界
- A 回归：`T01-T09` 中与 plan/引用相关部分，`R02-R03` 的无关媒体不失效，`B07-B09` 的安全边界不被 planning 绕过

## 10. 完成与停止条件

只有以下全部成立才可报告“B4 实现完成，等待审计”：

- B4-R1..R5 有行为证据且相关测试 exit 0。
- B4 聚焦、Studio 聚焦、root typecheck、build 和 `git diff --check` 通过。
- crash 使用真实新进程恢复；stale edit 使用真实 service/store/lease；inventory 使用真实离线消费边界。
- 没有 legacy fallback、planning 付费 create、说明卡、题材/镜头特判或无关重构。
- `JOURNAL.md` 与实际 diff/test 一致。

随后停止，不进入 B5，不 commit/push/deploy，不调用真实 Provider。审计者将直接检查共享仓库，并以新的 Oracle Web 独立会话复审 B4。
