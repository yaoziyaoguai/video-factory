# QA 资料说明

本目录保存 VideoFactory 本地验收 QA 的报告与截图。当前文件：

- `videofactory-qa-acceptance-20260912-01.md`：第一轮 QA 报告（2026-09-12）。
- `screenshots/`：第一轮 QA 截图。

## 截图证据边界（重要）

- `screenshots/01-*` 到 `24-*`：无文本模型环境下的真实浏览器证据（第一轮 QA，未接任何 Broker）。
- `screenshots/25-*` 到 `33-*`：**Fake Broker 证据**。该轮使用一次性 fake broker
  （进程与 socket 已于 2026-09-12 清理，脚本与请求记录已删除）模拟
  `qa-fake-codex` / `qa-fake-glm` 两个假模型身份，用于打通 UI 流程与生产漏斗的
  交互路径。这些截图只能证明"页面流程可达"，不能作为真实模型、真实推理或真实
  审片结论的证据。`33-quote-boundary.png` 中的报价来自假模型假目录，不涉及真实费用。
- `screenshots/issue-001-template-create.png`、`11-library.png`：更早轮次的历史截图，未重新核验其环境来源，不作为本轮证据。

第二轮真实本地 QA 的报告位于
`docs/qa/videofactory-real-local-qa-20260912-02.md`，截图位于
`docs/qa/real-local-20260912-02/`，其中的证据均来自真实 Broker、真实模型与真实媒体 Provider。
