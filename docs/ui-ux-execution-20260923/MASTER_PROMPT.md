# 接管 VideoFactory UI/UX 实施

你是本轮前端与交互执行负责人。不是重新设计视频流水线，也不是继续旧B/C或生产E2E修复任务。按本包完成UI实施、确定性回归和真实本地无付费UI QA，输出证据后停止。

## 1. 路径与必须完整读取的资料

仓库：`/Users/jinkun.wang/work_space/veidofactory`。先核磁盘，不能误进另一个 `video-factory` 目录。

资料包：`/Users/jinkun.wang/work_space/veidofactory/docs/ui-ux-execution-20260923`。

依次完整读取：

1. 本文件和 `README.md`。
2. `01_AUDIT.md`。
3. `02_DESIGN_SPEC.md`。
4. `03_IMPLEMENTATION_PLAN.md`。
5. `04_ACCEPTANCE.md`。
6. `05_QA_RUNBOOK.md`。
7. `SOURCE_MAP.md`、`RESULT.md`。
8. 根 `/Users/jinkun.wang/work_space/veidofactory/DESIGN.md` 和当前适用的AGENTS指令。
9. `/Users/jinkun.wang/work_space/veidofactory/docs/ui-ux-oracle-20260923/EVIDENCE_CONTEXT.md`、`evidence/manifest.json`，查看与当前卡有关的原截图。

证据勘误以本包为准：`02-projects-desktop.png`尚在加载，不是完成列表；H01/H02是历史图片。原Oracle咨询中断，没有最终放行，不要重发Oracle，也不要把旧 `ORACLE_REQUEST.md` 当本轮待执行命令。

然后按SOURCE_MAP读**当前相关源码全文、调用者和测试**。资料包行号只是导航。不要把485KB旧SOURCE_CONTEXT当作必须反复加载的“新的全项目需求”；磁盘当前源码才是依据。

## 2. 目标与已定设计

用户要的是“易用、视觉系统统一美观、动效有表现力”。沿用 Light Curated Studio 的冷白纸面、钴蓝、本地中文字体与真实媒体。不是模仿美团（那是笔误），不是更换品牌、卡片墙或营销页。

具体完成：当前决定/恢复/费用说清、作品和审片层级调整、讨论确认更顺畅、新建三组及误关保护、设置分区/模型三层更清晰、素材主动预览/许可可追溯、M1～M7动效尤其节点交接与真成片揭幕。UI不是只换颜色和圆角。

## 3. 基线与连续推进

审计基线 `main / 7eb7a84e56ebadeac4ffd774c427029fb9cc15a6`，tracked干净，已有untracked文档保留。开始先记录当前git、进程/端口与任务基线。若变化，只核对受影响部分；绝不reset、checkout覆盖、删除用户文件或重做已完成改动。

按 **UI-01→UI-02→UI-03→UI-04→UI-05→UI-06→UI-07→UI-08** 连续完成，不每卡等用户，不每个CSS细节再外审。一次写一个依赖链，不启动会同时改同一代码的多个agent。保持当前仓库，不建新仓库/新worktree。只有真实权限/安全/产品边界冲突才停相关工作，请求最小决定；独立可做项继续。

每卡先失败行为测试或前视觉证据，再实现、聚焦回归、记RESULT。不为通过测试按runId/题材/模型特判，不删保护断言。最后集中 `npm test`、差异审查、真实本地UI QA；全部命令需真实exit code。

## 4. 必须守住的业务边界

- 关键节点等用户明确确认，讨论可以多轮；保存、讨论、切页签、刷新、关闭均不是批准。
- 普通质量意见/低分/审查未完成与安全硬边界分开：合法接受风险入口保留，不能伪装审查通过；付费结果未知、必要产物/许可/取证/SHA不满足、过期版本不能绕过。
- 确认指向用户实际看到的run/revision/draft/check/intervention/evidence。弹窗期间更新后必须重新看，不用旧文案提交最新身份。
- source_assets与rendered_video分开。当前单视觉审片链，历史双审仅只读，不复活已退役生产依赖。
- 免费画面不等于整个视频免费。配音自动计费/订阅/报价/授权/实际/未知按现有规则呈现，不改收费语义。
- 模型接入→角色默认→本片/节点覆盖三层保持；模板仅资料；首页热点/系列/自己想法/案例四入口都保留。
- 前端展示可以重排，原handler/allowedActions/API输入/幂等/证据保护不能放宽。不改后端、Broker、Provider、数据库schema或工作流引擎。
- 不引入UI/动效大框架，不新增皮肤层，不夹带巨型文件清理。只修改计划允许的前端、测试和文档。

## 5. 本地QA权限

本包无新模型/媒体预算，不能继承旧30/50元授权。不新建真实run、不发送真实讨论、不确认门禁/报价、不重试或取回并推进、不改真实模型配置/密钥、不上传参考视频、不操作云端。

允许编译与确定性测试；允许真实本地只读导航、既有媒体播放、未提交表单填写与放弃、UI键盘/视口/动效检查。需要业务写或付费才能证明的状态用组件测试并明确标COMPONENT/UNIT，真实项写NOT_VERIFIED后另求授权。不要fake broker、篡改run/数据库、伪造片子或审片结果。

确定性回归后直接按QA_RUNBOOK开始**在权限内的**真实本地检查，不只交编译结果。服务若需重启，先确认没有活动任务/自动恢复副作用；不能证明安全就记录环境阻断，不自作主张结束用户任务。

不commit、不push、不GitHub/云端部署、不发布外部内容、不读取或打印密钥。相同失败无新依据不重复点；paid outcome未知尤其不能重试。

## 6. 报告与结束

统一更新本包 `RESULT.md`，不往多个旧RESULT并行写互相矛盾结论。至少包含：

1. 实际基线、文件/符号、每卡实现及偏差。
2. AC-01～AC-18逐项 `PASS / FAIL / BLOCKED / NOT_VERIFIED`，区分真实与组件证据。
3. 测试命令、开始结束时间、完整日志路径、退出码、失败/skip解释。
4. 本地服务实际版本、截图/录屏、viewport、runId、console/network观察。
5. 费用/操作账本：模型与媒体任务是否发起、真实写请求是否为0、供应商账单是否核验，不能未经核验写“账单确认0元”。
6. 字段分组映射、CSS归属表、M1～M7实际触发/取消/reduce验证。
7. 仍存在风险、未授权未验证项与最小下一步。

可以带明确QA缺口完成本次UI交付，但不可宣称产品已生产就绪或完整E2E通过。实现、回归与权限内QA完成后停止，等待用户统一审查。不顺手commit/push/deploy或继续生成视频。
