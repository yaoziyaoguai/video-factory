# VideoFactory UI/UX 实施资料包

日期：2026-09-23。作者：Codex，基于本地页面取证、当前源码与现有 `DESIGN.md` 的独立审计。

**这是待执行方案，不是已完成的 UI 改造，也不是 Oracle 放行结论。** Oracle 会话中断，未交付最终答案；用户已改为由 Codex 审计。本包不依赖继续咨询。

## 从哪里开始

执行 agent 完整读取 [MASTER_PROMPT.md](MASTER_PROMPT.md)，按 UI-01 至 UI-08 连续实施，集中回归和本地 UI QA 后停止。不要每个小步骤再发外审。

| 文件 | 用途 |
| --- | --- |
| [01_AUDIT.md](01_AUDIT.md) | 13 项发现、证据强度、哪些现有能力必须保留 |
| [02_DESIGN_SPEC.md](02_DESIGN_SPEC.md) | 唯一视觉方向、布局、状态文案、动效与交互规格 |
| [03_IMPLEMENTATION_PLAN.md](03_IMPLEMENTATION_PLAN.md) | 8 张实施卡，范围、失败证据、实现路径和检查 |
| [04_ACCEPTANCE.md](04_ACCEPTANCE.md) | 18 项验收与发现/任务的对应关系 |
| [05_QA_RUNBOOK.md](05_QA_RUNBOOK.md) | 实现后的真实本地 UI QA；不是付费视频生产测试 |
| [SOURCE_MAP.md](SOURCE_MAP.md) | 当前源码符号、测试和命令导航 |
| [RESULT.md](RESULT.md) | 执行者填写的唯一实施与验证结果入口 |
| [AUTHORING_VALIDATION.md](AUTHORING_VALIDATION.md) | 本轮资料包完整性检查；不是产品测试报告 |

设计目标：**易用、统一美观、有表现力的动效；作品和人的决定居中。** “美团”是用户笔误，不是品牌要求。沿用已确认的 Light Curated Studio，不换主题、不重建产品。

## 基线与证据

- 仓库：`/Users/jinkun.wang/work_space/veidofactory`。
- 分支 `main`，HEAD `7eb7a84e56ebadeac4ffd774c427029fb9cc15a6`。
- 审计时 tracked 工作树干净；既有 untracked 文档保留。本包是新增文档。
- 本地页面取证地址 `http://127.0.0.1:4320`，API 4321。地址和运行模式是本次事实，不是将来的固定启动配置。
- [证据背景](../ui-ux-oracle-20260923/EVIDENCE_CONTEXT.md)、[源文件及截图 manifest](../ui-ux-oracle-20260923/evidence/manifest.json)、[截图目录](../ui-ux-oracle-20260923/evidence/screenshots/)。旧目录名含 oracle 仅表示最初采集目的，不表示外审成功。
- **证据勘误：** `02-projects-desktop.png` 正文仍在“正在读取制作记录”，不能作为已加载列表证据。本包要求实现后补拍真实列表。`H01/H02` 是历史截图，不代表当前交互已通过。
- 本轮不跑产品 build/test、不提交生产动作、不花费。本包校验只证明资料完整、源码基线一致，不证明产品验收通过。

## 权限边界

此包只授权后续 agent 做前端实施、确定性测试、真实本地无付费 UI 检查；不修改后端工作流/计费/权限/许可协议，不新建业务 run、不确认已有 run、不发送真实讨论或重试、不改真实模型设置。需要这些操作的真实验证先列 `NOT_VERIFIED`，再单独请求授权。

不 commit、不 push、不云端部署、不读密钥、不删除用户文件、不篡改历史数据。不沿用旧的 30/50 元授权。
