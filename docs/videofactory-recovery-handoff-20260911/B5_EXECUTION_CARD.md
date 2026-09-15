# B5 单阶段执行卡：局部返工、媒体复用与双审收口

任务编号：`VF-RECOVERY-B5`

执行者：Claude Code + GLM 5.3 Flash 最高可用 thinking。审计者：主 Codex + Oracle Web。只在 B4 已明确 `ACCEPTED` 后执行；否则报告前置阻断并停止。

## 1. 用户可观察目标

当审片或用户提出修改时，系统能把问题送回正确环节，保留所有仍合格成果，只重做真实依赖范围。无法定位的反馈要求用户补范围而不是全片重做或静默消失。两个审片模型始终对同一证据独立审片，补审不重渲染、不重买素材。

## 2. 当前已确认事实

- B5 聚焦 156/159，三项失败集中在跨 run reference、多级依赖闭包和缺 SHA 证明。
- voice timing 已能选择 joint plan。
- scene reuse 已失效 `asset-source-review` 并保留目标 cut 的 duration/source offset/asset key/crop。
- old/new dependency closure 与显式 REUSE fixed-point 已修。
- planning issues 已进入 script/director producer payload。
- 仍存在跨 run 转存丢 proof、复用 predicate 不一致、未定位反馈被跳过、无关 planning role 重跑、双审 snapshot/identity/cache/capacity 和影响摘要问题。

详见 `oracle/results/B5_ORACLE_TRANSCRIPT.md`。不得回退已修 fixed-point 或恢复“scope 内全部重买”。

## 3. 允许修改范围

- `packages/production-pipeline/src/generative-asset-worker.ts`
- `contracts.ts` 中现有 rework/finding/范围合同
- `production-pipeline.ts` 的 source inheritance、局部失效、voice timing、review recovery 和 impact summary
- `codex-visual-review.ts`、现有 role-loop/checkpoint 接缝
- Studio `production-studio.ts`、`studio-service.ts` 和返工 DTO/UI 的最小接入
- 当前相关 tests：generative asset、visual review、contracts、joint rework、studio service/client

B4 的 topology/output/editing 不在本阶段重构；如果当前 B4 实际未放行，停止而不是在 B5 添加替代读取路径。

## 4. Non-goals

- 不设计 C1/C2 金额、funding、授权 UI。
- 不增加第三审片模型或第三份返工模型判决。
- 不为总调用数 4/5/7 写镜号或 fixture 特判。
- 不把依赖闭包中每个消费者都当成一次新购买。
- 不因无法证明复用就直接自动购买；先补证或停在用户决定。
- 不以说明卡、截断 findings、扩大容量常数或清空 checkpoint 掩盖问题。

## 5. 必须先建立的失败证据

### B5-R1：显式返工状态和责任

统一表达至少四类媒体状态：

- `unmaterialized`
- `materialized_awaiting_review`
- `actually_rejected`
- `insufficient_evidence`

再区分动作：`reuse_proven`、`retain_bytes_reinspect`、`needs_evidence`、`regenerate_explicit`、`needs_scope`。

测试 note-only、中文镜号未解析、越界镜号、voice-only、用户反馈与模型 findings 并存。原文/来源必须保留；无法定位进入可操作 `needs_scope`，不默认全片、不返回空操作后继续执行。

### B5-R2：逐母片复用证明

- 三代 run：`1 → 2 → 3` reference 链；第二代明确只替换独立母片 4；第三代无变更。
- 每一代 ledger 保留 reference SHA、resolved request digest、source run/version/artifact 和 materialized proof。
- 缺 SHA、错误 SHA、源字节或 revision 改变时不能继承；先查历史已执行记录，不用当前 SHA 猜填。
- 改旁白标点、另一镜头或显示文案不失效实际请求未变的母片。
- 改 prompt/model/reference/明确重生成意图必须失效。

### B5-R3：闭包与 create 集合分离

- 明确重生成根母片，reference-derived 后代进入失效/重验闭包。
- REUSE 消费者更新绑定并复验，但不按消费者数量 create。
- 对三项当前失败测试同时断言：操作意图、闭包、继承集合、重验集合、create 集合、SHA、request digest、逐项 task/create 次数和下一状态。

### B5-R4：新 rework run 保留无关 planning

只修 media/director 时，未变 treatment/script 的 producer 实际调用为 0，artifact、stage identity 和实际 provenance 可核验。不能先调用再合并旧稿。

### B5-R5：双审证据和恢复

- 先生成共同不可变 evidence envelope，再给两个 reviewer 独立副本。
- 汇总核对两边实际消费的 snapshot identity 与实际 provider/model。
- 单分支失败保留另一边同证据报告，只补失败方；render/voice/media create 为 0。
- 名义配置不同但实际 identity 相同：冲突分支内外 checkpoint 都失效并真正执行；第一分支不重做；次数有界，无法恢复则停顿。
- 26+25、50+50 及多来源 findings 不被静默截断；容量超出时保留原报告和未处理问题 identity，返回可操作状态。

### B5-R6：完整复验顺序和影响摘要

素材修改后事件偏序为：素材 preflight 成功 → render → technical review → 两边 review → final gate。voice-only 媒体 create=0；review-only 不 render。joint impact summary 从真实 stage receipts 投影，缺证据显示 unknown 而非 0。

## 6. 推荐实现顺序

1. **读取当前三项失败 fixture 并分类。** 总次数只作结果之一；先写上述结构断言。记录哪些 expected 已过时、哪些实现违反合同。
2. **先收口状态/动作/范围合同。** 让 user/model feedback、owner、scope、evidence identity 和 allowed actions 在 core→Studio 往返不丢失。
3. **统一逐母片 predicate。** 前置报价、carry-forward、prepare、worker execution 使用同一 authoritative classification；alias 只表达复用，不篡改已执行 input proof。
4. **保全跨 run reference proof。** 转存 materialized item 时保留/验证实际 reference SHA、resolved digest 和 source lineage；当前 operation ID 可变，已执行内容身份不能退回未解析。
5. **在 producer 前继承无关 planning。** 使用 B4 正式 current artifacts/identities，不能从当前新 run 空 history 猜测。
6. **闭合双审 envelope/cache/capacity。** 不可变共同证据、实际 identity、仅冲突分支恢复、统一容量/溢出状态。
7. **修复 impact projection 与 UI。** 用户看到待定位、待补证、保留、重做和是否需要 C1；不显示错误的 0 次。
8. **集中验证后停止。** 不进入 C1。

## 7. 必须运行的检查

根据实际 scripts 调整入口但保留相同覆盖：

```bash
cd /Users/jinkun.wang/work_space/veidofactory

npm run build:pipeline

node --test --test-concurrency=1 --import tsx \
  packages/production-pipeline/test/generative-asset-worker.test.ts \
  packages/production-pipeline/test/codex-visual-review.test.ts \
  packages/production-pipeline/test/contracts.test.ts \
  apps/studio/test/production-joint-rework.test.ts \
  apps/studio/test/studio-service.test.ts

# 补当前 repo 中负责 role-loop、pipeline rework、voice timing、review recovery 的既有 suites
# 使用实际文件名运行并记录，不得因某文件名与旧资料不同而跳过。

npm run typecheck
git diff --check
```

必须运行 B4 的关键 regression：formal artifact closure、planning role 调用计数、stale editing、joint/legacy 拓扑。若 B4 回归，B5 不得报告完成。

## 8. 对应验收

- `R01-R07`
- `B03-B04`：合法复用与同质量省钱，不达质不因便宜获准
- `B08-B10`：accepted/unknown 不重发、能力不足不持续申请钱
- `M05`：两个实际 reviewer、同证据、声音/动作证据边界
- B5 专项 `B5-R1..R6`

## 9. 完成与停止条件

只有以下都满足才可报告“B5 实现完成，等待审计”：

- 三项原失败的合同裁定和新结构断言全部通过。
- `needs_scope` 不全片、不吞反馈；四媒体状态和动作闭环。
- 三代 reference proof、真实 create 集合和逐条 ledger 可核验。
- 无关 treatment/script producer 调用为 0。
- 双审共同 snapshot、identity collision 的真实 role-loop 恢复和容量证据完成。
- 素材/声音/补审三条执行偏序正确。
- 相关聚焦、B4 regression、typecheck 和 `git diff --check` 通过。

完成后更新 `JOURNAL.md` 并停止。不进入 C1，不 commit/push/deploy，不调用真实 Provider；由审计者用新 Oracle Web 会话复审 B5。
