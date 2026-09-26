# 本包制作基线与证据界限

核对时间：2026-09-19 19:24–19:25 +08:00。
仓库：`/Users/jinkun.wang/work_space/veidofactory`；分支：`main`。
HEAD：`08b8b000180cdf7b8ec5d509e64ab436f1dcf09d`。

## 工作树

制作本包前 tracked 文件无修改，另有三份未跟踪文档，均须保留：

- `docs/VideoFactory-五维审计与单会话实施计划-2026-09-18.md`
- `docs/prompt_审计结果`
- `docs/审计实施记录.md`

本包自身是新增文档，不是产品源码变更。执行端重新采集 `git status --short --untracked-files=all`、`git diff --stat` 和 HEAD，不能将本包文档数误认为新增产品变更。

最近四个提交：67229d8（退役组合根）、fea9033（单/双形态合同）、22dc98a（单审断言）、08b8b00（正式开工门槛改为单审）。旧交接的 fea9033、9 dirty、assembly 12 项待重写已不是当前基线。

## 关键源码 SHA-256

这些 hash 是核对漂移用，不是要求执行端修改后仍相等。

| 文件 | SHA-256 |
|---|---|
| apps/studio/src/server/role-agent-assembly.ts | 587e33398fa08fb9aa8a99ecd04e1c703d1a6b44886fa8c67ec5259fc5b2f799 |
| apps/studio/src/server/production-studio.ts | 76255b1afc8add464a91b0f935eef54a0ecc7d8302686df7f5021d396860ac5b |
| apps/studio/src/server/studio-service.ts | 30553d71628113481e2b321505ef9f231588c50dfbc0e181881a5b4df8f43cbc |
| apps/studio/src/client/components/NewRunDialog.tsx | 7b6409c703d06a354edf830dc9cd7756cbf24e4bc65783e4c236c2384dd6bcec |
| apps/studio/src/client/pages/ResourcesPage.tsx | a2af8432d512f6c803c77624aa2b48749b5ec2ca586951d2d47c3b7602ff730e |
| packages/production-pipeline/src/production-pipeline.ts | bc4e05f0e6f6f59de530749d121f25e924412bc304b92ecd5a8597e3429998c8 |
| packages/production-pipeline/src/generative-asset-worker.ts | ab6929d3486d1c4fa6e65157cb6844c0962d58c2535202b04587b4d728adf5a1 |
| packages/production-pipeline/src/model-fallback.ts | 0a29a01d9ad007626f2dccccc6948f7e4bafbf01bb7cbeb28b2e433ce425f3fb |
| packages/workflow-core/src/workflow-runner.ts | d20c22467e1ea713337b943b3860666ae768f0f248f1a963b87a8ba4824793bf |
| apps/codex-broker/src/chat-completions-executor.ts | 2ad2f252a537e0a890b32b6d59d5926a01e99f70c1cc3062d23facf32ba04232 |

## 本机证据，不能外推

- 此 shell 的 Node v26.8.1、npm 11.19.0；这不证明现有服务/原生依赖使用同一 Node。执行端先核实 ABI，不能把 better-sqlite3 环境失败当业务回归。
- 本次接管读取时 Web 4317/API 4318 在运行，API health 为 ok，Python/ffmpeg/ffprobe/say 可用。PID 随时可能变，重启时重新确认。
- run-4399d1bb-38b8-4b6c-b048-422a8b934c4c 已到 creative-planning/creative_review、needs_human，“前期构思已生成，等你确认”。不是仍在后台生成。
- 历史 run-1278a59f-b336-414e-844e-6a205cd9781d 在 assets 中断失败；已有媒体与历史 ¥5 记录须保留，不视为新 run 授权。
- Graphify 图较旧，本轮不重建；源码与 Git 状态优先。
- 本轮只读源码/状态并编写资料，未运行产品测试、未调用模型、未购买素材。提交记录所述 root904/Broker248/Studio591+439 等是历史报告，不是本轮独立验证。
- `git diff --check` 在编包前退出 0；最终文档检查见交付说明。

资料包的缺口判断分为“静态确认”与“待跨层验证”，不把旧报告中的猜测视为当前缺陷。

## 资料包自检（不是产品测试）

- 8 份文档均生成；代码块闭合，明确引用的源码/测试文件路径存在。
- 上表 10 个源码 SHA-256 与磁盘一致；A01–A30 均有明确验收行。
- Git tracked diff 仍为空，新增仅本包；原有三份未跟踪文档保留。
- 本轮未跑编译、类型检查、回归或真实 QA，未提交、推送、部署或调用模型。
