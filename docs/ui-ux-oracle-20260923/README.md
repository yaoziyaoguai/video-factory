# VideoFactory UI/UX 外审与实施资料包

当前状态：**第三次咨询因浏览器提前退出而中断，尚未获得完整审计答案或可执行资料包。已停止，没有自动发起第四次。**

目标：在保留用户逐节点确认、费用安全、现有模型与素材能力的前提下，提高易用性、统一视觉系统，并增加有表现力且不妨碍操作的动效。用户已澄清“美团”为笔误，不按美团品牌设计。

## 权限

本轮只读产品源码与当前本地界面、向 Oracle 发送选定材料、整理文档。没有修改产品源码，没有触发项目生产中的模型/媒体任务，没有 commit/push/deploy。本轮收到完整资料包后停止，由用户交给另一个 coding agent 实施。

## 当前材料

- `ORACLE_REQUEST.md`：发给 Oracle 的完整请求。
- `EVIDENCE_CONTEXT.md`：当前基线、产品不变量、现场观察、证据分级和截图索引。
- `SOURCE_CONTEXT.md`：23 个当前源码/配置/测试文件的全文或标明范围摘录。
- `evidence/manifest.json`：原文件哈希、范围、截图尺寸和来源。
- `evidence/screenshots/`：16 张本轮真实页面截图 + 2 张历史停点截图；其中选取 14 张发给 Oracle。
- `evidence/oracle-preview.log`、`evidence/oracle-consultation.log`：预检与咨询记录。

源码基线：`main / 7eb7a84e56ebadeac4ffd774c427029fb9cc15a6`。当前界面采集地址：`http://127.0.0.1:4320`。工作树原有未跟踪文档保持原样。

第三次 Oracle 预检：17 个附件打包（3 个文本 + 14 个 PNG），约 127,942 tokens，压缩包 2.8 MB。会话 `vf-ui-ux-motion-20260923-03`，`--browser-thinking-time max`。网页已验证“第 5 项，共 5 项”，并提交为新对话；CLI 模型名称不是网页模型证明。

### 用户要求重发记录

用户指出上轮所选思考能力不符合其最高档要求，并明确要求重发。第一轮 `vf-ui-ux-motion-20260923-01` 没有交付最终回答，结果不采用。已按其 metadata 核对并关闭该轮 Chrome PID 10078；运行器随后退出，PID 不再存活、临时目录 `oracle-browser-aQHyYu` 已由运行器删除。没有触碰普通浏览器或源 Profile、没有向 controllerPid 发信号。

第二轮使用全新会话和隔离浏览器，不复用旧对话；重新完成 doctor、文件预检、23 份源码哈希核对和独立进程检查。旧日志保留；本次日志为 `evidence/oracle-preview-02.log`、`evidence/oracle-consultation-02.log`。这次重发来自用户明确指令，不是自动失败重试。

第二轮结果：网页控制日志确认“第 5 项，共 5 项”，但在 `submit-prompt` 阶段返回 `trusted-target-mismatch`，原文 `Trusted send target failed hit testing (target-mismatch).`。metadata 的 `promptSubmitted=false`，没有新 conversation ID，不能宣称材料已提交。运行器已退出；仅核对该会话记录的 Chrome PID 18400 已结束、临时 Profile `oracle-browser-IKP0r7` 已清理。没有手动点击、刷新、换档或自动启动第三轮。

第二次失败后按 oracle-web 的失败即停止规则暂停，未自动重试。用户随后回复“可以”，明确同意第三次尝试。第三次会话为 `vf-ui-ux-motion-20260923-03`，已重新完成 doctor、预检与独立进程检查，23 份源码哈希均未变化。

第三次仅调整材料递交方式：将完整 ORACLE_REQUEST.md 一并作为附件，网页输入框保留简短任务指令；不删减审计要求、源码或截图。实际上传 17 个文件（3 个文本 + 14 个 PNG），约127,942 tokens，2.8 MB 打包文件；使用 `--browser-thinking-time max`。日志为 `evidence/oracle-preview-03.log`、`evidence/oracle-consultation-03.log`。

第三次已成功提交，新对话为 `https://chatgpt.com/c/6ab346e9-bc14-83ea-96ab-542cbc0b6f81`。metadata 记录档位验证成功和新 conversation ID；只读核对该准确 target 的 main 区域，已看到“你说”、附件卡片、完整用户指令以及“正在分析图像”的处理状态，未对 Oracle 网页做额外点击或输入。

### 第三次咨询的最终状态

2026-09-23 11:55（Asia/Shanghai）核验：运行器 exit 1；metadata 为 `status=error`、`stage=connection-lost`、`disconnectCause=chrome-closed`、`recoverableDisconnect=false`。最后一条等待心跳为约 27 分 30 秒。错误原文：`Chrome window closed before oracle finished. Please keep it open until completion.`

已确认本次不是档位验证失败或未提交：第 5/5 档验证成功，且准确会话页面曾显示附件、用户已提交消息及持续的分析进展。现有证据只能说明 Chrome 提前退出，不能断言是用户关闭、系统关闭还是崩溃。

- 精确 Chrome PID 19933 已不存在；该轮临时 Profile `oracle-browser-IpG5Oa` 已由运行器清理。未向 controllerPid 发信号，未触碰源 Profile 或普通浏览器。
- `ORACLE_RAW_ANSWER.md` 不存在，六份实施文档尚未生成。没有把页面中的中间说明或设计方向当作最终审计结果。
- 此错误不是“答案捕获超时”，不适用技能的 `oracle session --render` 超时恢复路径；未执行恢复命令或第四次咨询。
- 重新核对 23 个源文件：23/23 SHA256 与输入基线一致，HEAD 仍为 `7eb7a84e56ebadeac4ffd774c427029fb9cc15a6`。
- 最小后续：用户可打开已提交的[原对话](https://chatgpt.com/c/6ab346e9-bc14-83ea-96ab-542cbc0b6f81)，确认云端是否留下完整回答；如有，可把完整回答或文件交回整理，无需重新咨询。没有答案时，任何新一轮咨询需用户重新明确授权。

本地状态证据：`evidence/consultation-result-03.json`、`evidence/oracle-consultation-03.log`。此目录目前仍是**审计输入包**，不是可交付实施的完整资料包。

### 证据标注补充

等待期间再次目视核验发现：`02-projects-desktop.png` 的正文是“正在读取制作记录”，不是加载后的制作列表。`EVIDENCE_CONTEXT.md` 原索引中“待处理/失败/已完成”只是页面能力描述，不能作为这些状态已在截图中出现的证据。本补充不改写已经发送的输入；外审页面中间说明也指出了同一限制。后续如取得结果，须检查其没有据此虚构列表已完成视觉验收。

## 完成后应出现的交付物

1. `01_AUDIT.md`：证据分级的发现清单。
2. `02_DESIGN_SPEC.md`：视觉、布局、动效与无障碍规范。
3. `03_IMPLEMENTATION_PLAN.md`：分阶段实施卡。
4. `04_ACCEPTANCE.md`：验收矩阵。
5. `05_QA_RUNBOOK.md`：本地真实 UI QA。
6. `MASTER_PROMPT.md`：交给下一个执行 agent 的入口。

收到后还需核对产品不变量、实际文件路径、执行与验收引用，不能仅因 Oracle 输出了文档就视为产品验收通过。
