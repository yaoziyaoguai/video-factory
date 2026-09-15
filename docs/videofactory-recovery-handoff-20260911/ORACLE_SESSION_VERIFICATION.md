# Oracle Web 会话验证

四批均按 2026-09-11 磁盘上的 `/Users/jinkun.wang/.codex/skills/oracle-web/SKILL.md` 执行。未使用旧 `oracle` Skill，未检查或升级 Oracle CLI/wrapper，未人工点击发送，未复用旧 conversation、followup 或 browser tab。

| Batch | Slug | Conversation | 网页强度证据 | 提交/答案 | 运行量 | 清理 |
| --- | --- | --- | --- | --- | --- | --- |
| B4 1/4 | `vf-recovery-b4-audit-20260911-01` | `6aa37eed-b080-83eb-aceb-47893143513f` | `Pro，第 5 项，共 5 项`，`verified=yes` | 新 `/c/...`，`promptSubmitted=true`，完整 transcript | 19m18s；↑253.43k / ↓6.94k | PID 46192 已退出；`oracle-browser-0j2gTg` 已删除 |
| B5 2/4 | `vf-recovery-b5-audit-20260911-01` | `6aa383be-3700-83ed-b2eb-4c7e1666cad6` | 同上，第 5 项 | 新 `/c/...`，完整 transcript | 19m58s；↑216.89k / ↓6.63k | PID 50704 已退出；`oracle-browser-b2GRuM` 已删除 |
| C1 3/4 | `vf-recovery-c1-audit-20260911-01` | `6aa388ac-c240-83eb-8ebc-b038df41912c` | 同上，第 5 项 | 新 `/c/...`，完整 transcript | 17m29s；↑134.53k / ↓6.33k | PID 55493 已退出；`oracle-browser-nmekku` 已删除 |
| C2 4/4 | `vf-recovery-c2-audit-20260911-01` | `6aa38d06-9580-83eb-b18f-0b3e7dc4e31c` | 同上，第 5 项 | 新 `/c/...`，完整 transcript | 15m37s；↑237.12k / ↓6.95k | PID 59635 已退出；`oracle-browser-JhDUqz` 已删除 |

`oracle/results/*_ORACLE_TRANSCRIPT.md` 只归档网页捕获的答案正文，不包含 wrapper 的强度选择 footer。因此，直接在 transcript 中搜索“第 5 项”未命中不表示强度未验证；上表强度、提交、PID 和临时 Profile 证据来自各独立 session 保留的 `meta.json` 与 `output.log`。transcript 用于审计建议内容，session 元数据/日志用于证明本次网页调用是否合规。

结果路径：

- [B4 transcript](oracle/results/B4_ORACLE_TRANSCRIPT.md)
- [B5 transcript](oracle/results/B5_ORACLE_TRANSCRIPT.md)
- [C1 transcript](oracle/results/C1_ORACLE_TRANSCRIPT.md)
- [C2 transcript](oracle/results/C2_ORACLE_TRANSCRIPT.md)

四次 verdict 均为 `CHANGES_REQUIRED`。这是分析建议，不是源码修改授权，也不表示 Oracle 独立运行了仓库全量测试；每份 transcript 均列出其证据边界。
