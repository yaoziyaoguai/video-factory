# VideoFactory 恢复审计：B5（Batch 2/4）

你是独立的架构与实现审计者。你只负责分析、规划、审计和执行建议，不修改文件、不调用付费 Provider、不部署。当前主 Codex 会核对你的结论并整理成供 Claude Code + GLM 5.3 Flash 执行的资料包。你可以在内部做并行的多视角分析，但最终必须输出一份统一结论。

## 项目与基线

- 仓库：`/Users/jinkun.wang/work_space/veidofactory`
- 分支：`codex/final-dual-review-cloud-acceptance`
- HEAD：`570fe6e59e072c4965c86769bf2096825f003383`
- 工作树含累计未提交 A/B/C 修改：86 tracked + 22 untracked，tracked diff 约 `+13248/-692`。
- A 已由用户确认；B4 当前仍在恢复审计，不得假定已经 ACCEPTED。请明确区分 B5 自身问题与 B4 前置缺口。
- 旧资料和旧 `JOURNAL.md` 是历史设计/记录，不是当前完成证明。
- 本轮不改源码、不 commit/push/deploy、不读取密钥、不调用真实 Provider。

## Batch 边界

Batch: 2/4

本批范围仅为 B5：制作失败、审片建议和用户返工如何回到正确环节，并最小化重做范围，包括：

1. findings/用户反馈到 script/director/source/voice/edit/review/user 的结构化所有权和实际 payload 传递。
2. 未物化、已物化待审、真实不合格、证据不足四种状态的行为。
3. 局部返工的依赖闭包、固定点、reference-derived master、多级引用、SHA/来源证明和跨 run 合法继承。
4. script/director/voice/media/review 各类修改应重跑什么、必须保留什么，以及素材 preflight/render/technical review/双审的顺序。
5. 用户 note-only 或无法定位的反馈不得静默扩大成全片，也不得变成空范围后悄悄无事发生。
6. 双审分支的真实 reviewer identity、同 snapshot 独立性、失败分支补审、缓存键和容量边界。
7. 无新增媒体费用的合法返工可自动继续；涉及媒体 create 只标记为需要 C1 决策，本批不能自行授权。

排除范围：

- 不修 B4 的核心接入，只标出它如何阻断 B5。
- 不设计 C1/C2 的金额、授权 UI 或 funding request。
- 不审 C3-C6、部署或真实付费 E2E。
- 不新增第三审片模型、第三份返工判决或按具体题材/镜头特判。

## 当前确定性证据

- B5 聚焦：159 tests，156 pass，3 fail。
- 失败分别为：
  - `carries an unaffected multi-level reference chain across runs with one new paid call`：actual 4，expected 5；
  - `regenerates the full human-approved reference dependency closure`：actual 4，expected 7；
  - `refuses to inherit a reference-derived master whose reference SHA cannot be proven`：actual 6，expected 7。
- 失败集中在跨 run 媒体继承、引用依赖闭包和 reference SHA 证明边界。
- Studio 还有一项语义冲突：note-only 用户拒绝当前得到空返工范围，旧测试期待全片 `[1,2,3,4]`。最新产品原则是不因无法定位自动扩大到全片，但也不能吞掉反馈；请给出通用状态/交互合同，而不是为该 fixture 特判。
- `npm run typecheck` 目前失败，但主要是 B4/C2 跨层 DTO/fixture 不同步；请只把真正属于 B5 的类型缺口计入本批。

附件中的旧 B5 Oracle transcript 是历史 finding。当前源码此后被修改，请对旧 F1-F9 逐项给 `RESOLVED`、`PARTIAL`、`OPEN` 或 `OBSOLETE`，引用当前证据，不直接复制旧 verdict。

## 不可破坏规则

- 局部返工不能扩大成全片；依赖闭包必须完整到足以保证引用合法和成片一致。
- 可继承的是经 SHA、来源、实际输入和当前质量合同证明仍适用的 artifact，不是“文件存在就复用”。
- 改素材后必须经过相应 preflight、render、technical review 和同证据双审；只改声音不能买素材；仅补缺失审片分支不能重渲染。
- 证据不足先补查已有媒体，不能直接列购买清单。
- 两个审片模型必须互不可见、读取同一 snapshot、记录实际 provider/model；单分支失败可有界补审，但不能拿旧报告批准新视频。
- 找不到明确影响范围时，应要求用户选择/澄清或生成可操作的停顿状态，而不是自动全片或空操作。
- 不能用说明卡填补失败素材。

## 要求输出

用中文输出，代码标识符保留原文，并严格按下列结构：

1. `ACCEPTED` 或 `CHANGES_REQUIRED`。
2. B5 合同点完成矩阵：`PROVEN/PARTIAL/CONTRADICTED/UNVERIFIED`。
3. 旧 F1-F9 复核表：`RESOLVED/PARTIAL/OPEN/OBSOLETE`，含当前位置、剩余场景和阻断级别。
4. 当前新增 P0/P1/P2 findings；合并同根因，不为三个失败断言各写一个 case 补丁。
5. 一张通用的返工影响矩阵：用户/审片输入类型 → target owner → invalidated stages → reusable evidence → 是否允许新媒体调用 → 用户可见动作。
6. 对三项失败测试判断：实现 bug、测试过时或二者皆有；给合同层答案，禁止用调整 expected 数字掩盖错误。
7. 适合 Claude Code + GLM 5.3 Flash 的 B5 单阶段执行计划：允许文件、non-goals、失败测试、最小实现顺序、通过标准。
8. 精确验证矩阵：多级 reference、缺 SHA、全依赖闭包、note-only/无法定位、四媒体状态、voice-only、review-only、review identity collision、局部修改后的完整复验顺序。
9. 末尾输出：

```yaml
codex_execution_advice:
  implementation_plan:
    - <有序具体步骤>
  non_goals:
    - <明确排除>
  optional_subagents: []
  verification:
    - <检查与预期证据>
```

Oracle 只提供建议，不授权实现、付费或部署；证据不足写 `UNVERIFIED`。
