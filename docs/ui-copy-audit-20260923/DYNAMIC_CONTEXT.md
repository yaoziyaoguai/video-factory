# 动态文案与业务边界（给文案审计用）

这是源码定位摘要，不是运行时截图。审计者须将静态清单里的字符串与状态条件区分，不得把代码中存在的每一句都称为“当前页面可见”。

## 产品原则

- VideoFactory 是个人短视频创作工具。每个关键创作节点交付后由用户讨论、修改、决定是否继续；质量复核和素材建议不是自动否决用户创作的硬门。真正的费用授权、来源权利、运行安全等约束仍需准确呈现。
- 目标是让用户能推进到成片，同时如实显示低分、风险、未验证或失败；不可用“成功”掩盖未完成，也不可用“免费”替代可能产生的服务费用。
- 页面常见路径：创作台/选题 → 新建制作 → 创作规划与讨论 → 导演与分镜 → 候选素材/画面 → 配音 → 渲染 → 机器质检/视觉审片/人工终审 → 发布包。设置页包含模型、素材、费用、声音与发布配置。旧 run 可能只读。

## 动态来源和现有投影

| 入口 | 源码位置 | 当前行为/审计重点 |
| --- | --- | --- |
| 节点及状态名 | `apps/studio/src/client/presentation.ts:3-70` | `runNodeLabel()` 对未知 ID 直接回退为 ID；`creatorRunStatusLabel()` 拼接“等你确认{节点名}”。检查是否将技术 ID 露给普通用户。 |
| 模型/服务名 | `presentation.ts:120-200` | `providerLabel()` 未匹配返回 `undefined`；`providerModelLabel()` 有“未识别模型”。不能把未识别服务误说成另一已知服务，也不能隐瞒真实费用来源。 |
| 动态文本清洗 | `presentation.ts:204-323` | `humanizeCreativeText()`、`creatorFacingTechnicalText()` 以替换规则清洗 AI/服务端字符串；有的规则删除 `reasonCode` 等诊断，有的把未知内部能力 ID 写成“内部能力”。要检查是否损失用户需要的具体恢复动作、风险事实，或仍留下难懂字段。 |
| 创作轮次 | `presentation.ts:329-366` | `agentLoopPhaseLabel()`、`agentLoopPendingNote()` 区分进行中、失败、停住、轮次用尽。检查“失败却说正在生成”等矛盾文案。 |
| 通用请求错误 | `apps/studio/src/client/api.ts:492-497` | 已知两种服务端错误有中文兜底，其他错误正文原样呈现。若建议改为统一兜底，必须保留具体、可执行的错误信息与技术详情入口。 |
| 服务端失败映射 | `apps/studio/src/server/run-observability.ts:280-500` | `normalizeFailure()` 产出 `summary`、`recoveryActions`、`technicalDetail`；`technicalDetail` 只投影白名单字段。审计“不懂、误导、承诺过度”的恢复动作时需核对这里。 |
| 失败与恢复卡 | `apps/studio/src/client/components/RunWorkbench.tsx:130-205,625-685` | `taskRecovery` 将本地流程状态与原模型任务状态分开；`failure.summary`、`failure.impact`、`recoveryActions` 某些分支直接显示，某些经 `creatorFacingTechnicalText()`。折叠技术详情也会显示清洗后的文本。需避免同一故障出现矛盾动作/重复按钮。 |
| 审片/费用/人工决定 | `RunWorkbench.tsx:360-620`、`NodeWorkspace.tsx`、`CostDashboard.tsx` | 费用是预计、授权、已发生、未知结果等不同语义；人工接纳风险与修改/继续是不同动作。切勿通过文案更改业务门禁。 |
| 节点产物通用呈现 | `apps/studio/src/client/components/NodeDeliveryPreview.tsx:55-210,470-550` | `FIELD_LABELS` 之外回退为 `key.replace(/[_-]+/g, " ")`；`formatScalar()` 对多数自由字符串只做局部翻译。这是英文/技术键泄露高风险路径。结构化创作内容必须保留，不可一律隐去。 |
| 图库与素材授权 | `AssetsPage.tsx`、`ResourcesPage.tsx`、`StockAttribution.tsx` | 面向用户的来源、许可证、追溯信息不能误写成“可任意使用”；用户用于私人娱乐也应看到准确授权与来源。 |

## 审计输出的边界

这是文案与信息架构审计，不请求改自动化/费用/业务状态机。对动态错误、模型输出和未知字段，请分别给出：用户摘要、可执行下一步、可折叠技术细节；如需后端数据合同才能安全改，请明确“待核对”，不要臆造状态。
