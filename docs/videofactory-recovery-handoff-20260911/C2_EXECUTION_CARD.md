# C2 单阶段执行卡：报价、追加、调整、暂停与恢复体验

任务编号：`VF-RECOVERY-C2`

执行者：Claude Code + GLM 5.3 Flash 最高可用 thinking。只在 B4、B5、C1 均 `ACCEPTED` 后执行；完成 C2 后停止等待主 Codex + Oracle Web 审计。

## 1. 用户可观察目标

普通创作者先看见清楚的方案和同一份图片/视频报价，再确认开始。授权内自动制作；需要追加时能理解已完成成果、缺口和价值，并选择“同意追加并继续 / 调整方案 / 暂不继续”。刷新、断网、响应丢失和重开不会重复授权或丢失状态。用户不需要理解 CAS、lease、funding ID 或 Provider 部署细节。

## 2. 当前已确认事实

- service/API 142/150；UI 171/175；root typecheck 失败。
- quote/authorization/amendment、trusted actor、duration range、预算意向、模板推荐和部分 pause/UI 已经存在。
- amendment 不再接受客户端 `additionalCents`，URL authorization predecessor 已传递；quote source-level ownership 已加强。
- 当前 signature 已变为 `(runId, authorizationId, input, actor)`，部分 test/fake 仍按旧位置调用。
- UI 仍在一次操作中 prepare 后立即 authorize，未向用户展示 quote；返回 detail 被丢弃。
- funding 差额没有扣已花/在途，展示与签发金额可不同，非整数分会四舍五入；目录/可行性、命令恢复、草稿基线、pause UI/reload 和移动端证据未闭合。

详见 `oracle/results/C2_ORACLE_TRANSCRIPT.md`。

## 3. 允许修改范围

- Studio server：`production-studio.ts`、`studio-service.ts`、`app.ts`、当前 typed errors/auth mapping 的最小接缝
- shared/client：`shared/api.ts`、`client/api.ts`
- UI：`NodeWorkspace.tsx`、`RunWorkbench.tsx`、`NewRunDialog.tsx`、`PlanningStagesPanel.tsx` 的 expected revision 接入、`ProductionPage.tsx` 的现有 mutation/reload 接入
- 相关现有样式，仅为确认/追加面板、移动与可访问性
- API/service/client/node-workspace 及真实链路测试
- 有条件允许 C1 host/Pipeline/worker 的命令恢复或 pause 接缝；不得重写 C1 决策和 exact matcher

## 4. Non-goals

- 不重做 Studio、不新建强制页面或第二前端状态机。
- 不加钱包、充值、全站预算引擎、业务数据库、Redis。
- 不实施 C3-C6，不重写模板内容或 B4/B5 创作/返工。
- 不放宽 C1 quality、unknown、attempt、exact authorization。
- 不把旧测试签名恢复成客户端金额合同。
- 不调用真实付费 Provider、不读取密钥、不 commit/push/deploy。

## 5. 服务端唯一状态流

### 首次确认

```text
accepted plan ready
  → server prepare immutable quote（media create=0）
  → GET/run detail 投影 pending quote
  → UI 展示内容摘要、预计费用、最高授权、模型/有限修复
  → 用户明确点击确认
  → server 接受同 quote identity + stable idempotency key
  → 返回/可重读 accepted command + active scope + current run
  → C1 自动继续
```

不能在一次点击里 prepare 后自动 authorize；不能丢弃返回 detail。

### 追加与变更

```text
C1 assessment/funding request
  → UI 展示已保留成果、缺失目标、预计/最高追加、范围差异
  ├─ 同意追加并继续 → accept stored delta/scope diff
  ├─ 调整方案       → 预填 findings/缺口/影响范围，局部规划
  └─ 暂不继续       → durable pause，禁止新 media create
```

`URL authorizationId == funding.authorizationId == current active head`。金额足够但 model/effect/attempt 改变时允许 0 元 scope revision；历史 spend/reservation/attempt 不归零。

### 暂停和恢复

暂停是独立、持久的“禁止新媒体任务”状态，不只依赖 `run.status === paused`。每次 create/retry/backup 前检查；accepted/unknown 只 reconcile，reconcile 完成不自动进入下一 create。只有用户明确恢复才解除。

reload 读取原 pending quote/funding、active scope、accepted command 和 pause 状态；不得重新报价、重新生成 key 或自动重新授权。

## 6. 必须先建立的失败证据

### C2-R1：真实纵向服务链

通过 `buildStudioApp → StudioService → ProductionStudio → ProductionPipeline`，只 fake 外部 Provider transport/model。

- prepare media create/retry/backup 均为 0。
- real run A/B 交叉 quote、路径编码、外 run、plan/quality/catalog/price drift 拒绝且副作用 0。
- 未登录、无权 run、body actor 伪造按现有认证合同拒绝；`approvedBy` 来自 trusted actor。
- stale/lease/CAS 映射为可理解 409/accepted-result，不是 generic 500。

### C2-R2：权威金额和可行性

- 1000/250/200/600 → 50 分最高追加；接受前 create=0。
- quote/funding 使用 C1 去重账本，已 accepted/unknown 请求不重复进入新 work。
- 当前模型目录为空/模型失效、规格或价格变化：quote 失效或返回重新规划，不标 `feasible:true`。
- `requestedMaximumCny=6.006` 拒绝，不能四舍五入成 601 分。
- quote 显示的 `resultingApprovedAmountCents` 与接受结果完全一致；明确区分累计授权、本次追加和追加后累计。
- 无可行质量路线不提供“只加钱继续”。

### C2-R3：命令幂等、crash 和并发

- prepared 前后、grant 写入后、run save 后、receipt 失败、响应丢失。
- 同 key/同 body 返回同历史命令结果；同 key/不同 body 拒绝。
- 后续合法 supersede 后，重放旧 accepted command 返回“旧命令已接受 + 当前状态”，不恢复旧授权、不再次 delta。
- 不同 key 不能消费同一 quote/funding 两次。
- 同 key 并发、不同 key 同 revision、quote 与编辑竞争、pause 与 accept/resume 竞争只产生唯一接受结果。

### C2-R4：先展示再接受和三动作

- prepare 后 UI 显示服务端 quote；authorize 调用数为 0。
- 用户第二次明确点击才接受当前已显示 quote；quote 变更后旧按钮不能批准。
- funding 三动作真实调用各自 server command，结果进入现有 page mutation 和 reload。
- “调整方案”预填 B5 findings/缺失目标/保留成果/范围；不是空表。
- 无新增媒体费用时使用内容确认继续，不制造正金额 scope；TTS 不弹媒体审批。

### C2-R5：编辑基线、预算意向与文案

- 打开 v1 草稿，后台变 v2，保存旧草稿使用 v1 tokens 并得到 409；草稿保留，用户核对后才重绑。
- budget intention 默认 unset；重开同一 draft 恢复；切换 draft 正确切换；合法 0 不被 `|| undefined` 吞掉；预算意向不等于付款授权。
- 修复正式 source type errors、fixture `acceptedPlanDigest` 和重复 JSX 属性；不把必填字段改可选。
- 主文案使用普通中文：
  - “确认方案和图片/视频最高费用后，授权范围内自动制作”
  - “调整制作方案”
  - “已保留当前成果，不再发起新的图片或视频任务；已受理任务仍会核对结果”
- 技术 ID/CAS/lease/Provider deployment 仅在可展开详情。

### C2-R6：浏览器真实行为

1440px 和 390px：主要按钮不遮挡、无横向溢出、长 quote/脚本可滚动、触屏三动作可用；Tab/Shift+Tab、Enter/Space、Esc、关闭重开、断网、409、已接受但执行失败均不丢草稿/重复授权。保存截图和操作步骤。

## 7. 推荐实现顺序

1. **分类现有红测。** 同步新 amendment signature 和 expected revision fixtures；保留服务端金额/ownership/并发安全断言。删除固定“一次点击完成两请求”的错误 UX 断言，换成两阶段行为。
2. **消费 C1 assessment。** quote/funding 只从当前正式 plan、quality、目录/规格/价格、去重 ledger 和有限 repair scope 生成；不在 C2 复制金额逻辑。
3. **统一 quote/funding/command projection。** run detail 提供 approval kind、allowed actions、active scope、pending IDs、显示金额、scope diff、保留成果、缺口和 pause 状态。
4. **闭合接受和历史命令恢复。** stable command identity、server-owned body、整数分、accepted result 与 current state 分离。
5. **闭合 amendment/replan/pause/resume。** 三动作、0 元 revision、无费用内容确认；pause 检查到每个 create/retry/backup。
6. **先展示再接受。** 复用现有组件和 mutation，不新建状态机；保存同一 quote/key，处理断网/reload。
7. **修编辑基线、表单和文案。** 捕获打开时版本；同步类型；修预算初始化和普通中文。
8. **集中 real-service 测试和浏览器验收后停止。**

## 8. 必须运行的检查

```bash
cd /Users/jinkun.wang/work_space/veidofactory

npm run build:pipeline

node --test --test-concurrency=1 --import tsx \
  apps/studio/test/production-authorization-api.test.ts \
  apps/studio/test/api-contract.test.ts \
  apps/studio/test/studio-service.test.ts \
  apps/studio/test/server.test.ts

# 使用 apps/studio 已安装的 Vitest，不临时下载
cd apps/studio
npx vitest run test/client.test.tsx test/node-workspace.test.tsx test/creative-os.test.tsx
cd ../..

npm run typecheck
git diff --check
```

另运行 C1 authorization/worker/runner 集成和 B4 editing regression。真实浏览器按 `VERIFICATION.md` 留证。

## 9. 对应验收

- `B01-B10` 的用户确认/追加/暂停部分，重点 B01-B02、B05-B07、B09-B10。
- `U01-U06` 中确认、状态、编辑和移动可用性。
- C2 专项 `C2-R1..R6`。

## 10. 完成与停止条件

- service/API/UI 当前红项与正式 typecheck 全绿。
- quote 先显示后接受、三动作、无费用确认、0 元 scope revision、pause/reload/resume 真实闭环。
- 1000/250/200/600、非整数分、catalog drift、crash/idempotency/concurrency/security 都有真实服务证据。
- 1440/390 和键盘/长内容/错误恢复有浏览器截图与步骤。
- C1 exact matcher、unknown、quality、attempt 未放松；B4/B5 回归通过。

更新 `JOURNAL.md` 后停止，不进入 C3，不 commit/push/deploy，不调用真实付费 Provider。等待主 Codex + Oracle Web 审计。
