# VideoFactory 恢复审计：B4（Batch 1/4）

你是独立的架构与实现审计者。你只负责分析、规划、审计和执行建议，不修改文件、不运行付费 Provider、不部署。当前主 Codex 会核对你的结论并整理成供 Claude Code + GLM 5.3 Flash 执行的资料包。你可以在内部做并行的多视角分析，但最终必须输出一份统一、无冲突的结论。

## 项目与当前基线

- 项目：VideoFactory，一条面向普通创作者的 AI 视频制作流水线。
- 仓库：`/Users/jinkun.wang/work_space/veidofactory`
- 分支：`codex/final-dual-review-cloud-acceptance`
- HEAD：`570fe6e59e072c4965c86769bf2096825f003383`
- 当前工作树是累计的未提交实现，不是一个干净 patch：86 个 tracked 修改、22 个 untracked 文件，tracked diff 约 `+13248/-692`。
- 必须审计附件中的当前完整源码，不能把旧 `JOURNAL.md` 的 ACCEPTED 或旧 Oracle 结论当作当前事实。
- A 阶段由用户确认完成。本批不重做 A，但要检查 B4 是否破坏 A 的时间轴、产物绑定、媒体复用和付费安全。
- 当前不允许 reset/stash/checkout/clean，不允许 commit/push/deploy，不读取密钥，不调用真实 Provider。

## Batch 边界

Batch: 1/4

本批范围仅为 B4：`joint-v1` 创作规划接入生产主流程，包括：

1. 新 production 使用 joint planning，历史 run 仅保留读取/恢复兼容；新建返工 run 不应继续创建 legacy production。
2. joint 与 legacy 规划互斥，不能执行两套 script/director/candidates/rank/preflight，也不能在 joint 失败时静默 fallback 到 legacy。
3. reference grammar 的顺序、真实输入、复用与 parent/provenance。
4. treatment/script/director/search/rank/integrate/compile 的真实 port、payload、prompt/schema/producer identity 与 checkpoint identity。
5. 唯一 `planningOutputs` 投影、正式 artifact 注册、executable plan 内部引用和当前 run registry 的闭包。
6. LangGraph SQLite checkpoint 与 FileRunStore 跨存储提交的两个 crash window、幂等恢复、provenance 和保留 stage 兼容性。
7. planning stage DTO 的真实状态来源，以及 input/model 编辑的 revision/version/lease/CAS 和精确依赖失效。
8. 真实 worker/ranker inventory 到后续 materialization 的消费边界。

排除范围：

- 不设计或实现 B5 的制作返工策略，只指出由 B4 接入直接造成的回归。
- 不设计 C1/C2 授权产品，只检查既有付费边界未被 B4 绕过。
- 不审 C3-C6、部署、云端和真实付费 E2E。
- 不引入第二个工作流框架、Redis、微服务或新业务数据库。

## 当前确定性证据

- `npm run build:pipeline`：通过。
- `git diff --check`：通过。
- `npm run typecheck`：失败，Studio 中存在 `expectedRunRevision` / `expectedVersionId` 调用缺失、`acceptedPlanDigest` fixture 缺失和重复 JSX 属性。
- B4 pipeline 聚焦：144/144 通过。
- B4 Studio 聚焦：24/29 通过，5 失败：
  - planningStageId 输入覆盖先撞 stale conflict；
  - 校验顺序先报无效 revision 而非 stage 错误；
  - stage model routing 与 joint source adjustment 均撞 stale conflict；
  - treatment 已有正式 artifact，但旧测试仍期待无 artifact。
- 这些失败有的可能是测试过时，有的可能是跨层合同没有同步。请逐项依据当前源码裁定，不能为了绿测删掉正确的并发参数或正式 artifact。

附件中的旧 B4 Oracle transcript 只是一份历史 finding 清单。当前源码此后已被修改，必须对旧 F1-F10 逐项给出 `RESOLVED`、`PARTIAL`、`OPEN` 或 `OBSOLETE`，并引用当前源码证据；不能直接复制旧 verdict。

## 不可破坏的产品与架构规则

- 不按题材、镜头编号、runId 或模型写特判。
- planning graph 不能持有或调用付费媒体 create；素材付费仍在正式执行边界。
- 没有合格素材时停住并反馈，不能生成说明卡伪装成功。
- 当前新制作只有一条生产规划主路径；兼容只服务于历史 run 恢复，不是永久双轨和故障 fallback。
- 用户看到的状态必须来自当前 checkpoint/正式提交，不能拿旧 artifact 存在推断“已完成”。
- 导演前置不是增加一个旁观模型，而是让 treatment、script、director、素材可得性共享一份可执行方案。
- 修复应保留未来数字人、口播、照片转视频、短剧可复用的稳定边界，但本批不实现这些产品。

## 要求输出

请用中文输出，保留代码标识符原文，并严格按以下结构：

1. **Verdict**：只能是 `ACCEPTED` 或 `CHANGES_REQUIRED`。
2. **阶段完成度**：B4 每个合同点分别标 `PROVEN` / `PARTIAL` / `CONTRADICTED` / `UNVERIFIED`，给出当前文件、symbol/行号和理由。
3. **旧 findings 复核表**：旧 F1-F10 各自为 `RESOLVED/PARTIAL/OPEN/OBSOLETE`；列当前证据、剩余场景和是否阻断 B4。
4. **新增 findings**：仅列当前源码仍存在且旧清单未覆盖的问题，按 P0/P1/P2；说明失败场景、违反合同和最小修复。不要把测试陈旧误写成产品 bug。
5. **根因图**：区分一个根因造成的多个表象，尤其是 revision/version、artifact identity、checkpoint identity、跨存储 commit，不要给每个测试单独打补丁。
6. **最小实施顺序**：适合 Claude Code + GLM 5.3 Flash 一次完成 B4 的清晰步骤。每步给允许修改模块、non-goals、先写的失败测试、实现合同和通过标准。不能要求重写整个 `production-pipeline.ts`。
7. **验证矩阵**：列精确命令与行为断言；必须包含真实 service/store/runner、进程 crash recovery、双客户端 stale edit、无图库/有图库、历史 resume/新 derivative、rank intent 变化、正式 artifact closure。
8. **资料包建议**：指出执行者还必须读哪些当前文件，哪些旧材料只作历史。
9. 末尾给出：

```yaml
codex_execution_advice:
  implementation_plan:
    - <有序、具体、可由当前执行者落实的步骤>
  non_goals:
    - <明确排除>
  optional_subagents: []
  verification:
    - <检查与预期证据>
```

不要用“基本完成”。证据不足就写 `UNVERIFIED`。Oracle 结果只是执行建议，不授权修改、付费或部署。
