# 创作规划修复与页面整理：本地结果

状态：`LOCAL_CODE_VERIFIED / RUNTIME_ACCEPTANCE_PENDING`。下述验证只覆盖本地代码和页面；验证阶段未操作云端旧 run，未触发模型或媒体费用。

## 判断与实现

Oracle 评审结论为 `CHANGES_REQUIRED`，完整回答保存在 `/Users/jinkun.wang/.local/state/oracle-web/sessions/vf-creative-planning-ux-repair-20260924-01/artifacts/transcript.md`，送审事实在 `docs/creative-planning-oracle-context-20260924.md`。本轮针对的是已登记规划交付却在后续素材入口失败、页面误称规划未通过或没有交付，以及步骤展示过于机械的问题；没有更改用户决定推进、质量意见可知情接受、来源与费用不可绕过的边界。

- CP-01：正式发布与只读投影共用规划 commit 身份输入，包含有效的图库素材风险接受记录；读取仍校验产物登记、版本和 SHA。
- CP-02：素材 Worker 先用同一份正式脚本字节核对历史接受记录，再派生执行脚本；保留执行方案与派生范围校验，没有改写历史接受记录。
- CP-03：图库路线在导演初稿后先停下让用户讨论和采用，候选检索后仍保留第二次选材确认。两个停点有独立用途和草稿空间，未知结果的命令不能被新命令覆盖。导演角色因需用户决定而停下时也保持“初稿”用途，不会提前检索候选。
- CP-04：正式规划从当前有效版本与经核验的登记产物读取六类交付。正文读取失败与“尚未产出”分开表达；正文优先展示创作内容，内部编号不再充斥阅读区，产物编号与校验值单独折叠。
- CP-05/06：执行状态、用户决定与技术中断分别表达；保留五个制作章节，内部步骤和模型设置默认折叠，当前工作和正式交付优先显示。已有编辑、恢复及配置能力仍保留。

## 验证

- `PATH=/Users/jinkun.wang/work_space/veidofactory/.venv/bin:/Users/jinkun.wang/.nvm/versions/node/v22.23.1/bin:$PATH npm test`：exit 0。TypeScript 1019 pass / 1 skip；Broker 265 pass；Studio Vitest 525 pass；Studio node 611 pass；package 4 pass。
- `PYTHONPATH=src .venv/bin/python -m unittest discover -s tests`：212 tests，exit 0。
- 最后局部修订后，`CreativeDiscussionPanel` 29/29、规划交付组件 3/3、Studio typecheck、`git diff --check` 和正式 `studio:build` 均 exit 0。构建仅提示现有客户端 bundle 大于 500 kB，不影响退出码。
- 本地已有完成作品的只读页面：六类规划产物可打开；390px 宽度无页面横向溢出；控制台错误 0。此验证仅证明阅读体验，不等于新工作流真实跑通。

第一次全量执行时系统 `python3` 缺少仓库 Worker 依赖，`python-worker-client.test.ts` 1 条失败；将仓库 `.venv/bin` 放在 `PATH` 前端后，完整全量测试通过。正式测试环境应沿用该虚拟环境。

## 尚未验证

云端历史 `run-d8e0ed8c-cea0-4931-a1c6-047cd6ca7ae5` 的实际恢复、两次导演讨论停点的新真实运行、费用/请求对账与可播放成片均未在本轮执行。测试全绿不能替代这些运行时验收；尤其不能把“素材入口不再报错”称为“已经生成视频”。云端试用仍需按 QA 纪律验证；部署成功不等于运行时验收通过。
