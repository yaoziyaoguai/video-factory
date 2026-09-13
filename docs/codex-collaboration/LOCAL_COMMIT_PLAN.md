# 本地提交检查与建议

检查日期：2026-09-13。用户已明确确认两个本地提交范围；执行记录见末节。这里只建立工作基线，不宣布产品通过验收，不推送远程。

## 为什么有用

Git工作树dirty只是当前文件与上次提交不同，不意味着文件损坏或代码质量必然差。Agent能读取未提交文件；但几周修改混在同一diff里，不易区分已有实现和本轮贡献，审查、回退与跨窗口协作成本明显提高。未跟踪文件还不会出现在普通git diff里，容易漏审或没有进入后续提交。

commit保存到本机Git仓库，push才上传远程。GitHub暂停不影响本地提交；本地commit也不是异机备份。它能改善基线管理，不能自动修复合同、规划规则或测试不足。

## 提交前核对快照

- HEAD：570fe6e59e072c4965c86769bf2096825f003383。
- 当前分支：codex/final-dual-review-cloud-acceptance；不是默认分支。
- 暂存区为空。
- 已跟踪修改113个；未跟踪产品/测试文件37个，合计**150个产品/测试/配置文件**，约6.56 MiB。
- 文档、历史证据、截图等另有243个文件，约38.09 MiB（统计发生在本文件创建前，后续资料新增会改变该数）。未发现单个超过1 MiB的待提交文件，但截图合计体积仍较大。
- 基线r9-start-baseline.json中的322个产品/测试/配置文件hash全部一致；资料准备没有改产品代码。
- 没有发现待提交路径含.env、私钥文件、数据库、socket或运行日志扩展名。现有.gitignore忽略.env、workspace、data、.local、node_modules、dist、graphify-out等。
- 对产品候选做高置信度密钥格式检查，一处匹配已核实为codex-executor.test.ts脱敏测试的虚构token，不是真实凭据。此检查不能证明绝无敏感信息；没有读取.env或真实凭据。
- 根级协作文档检查未匹配上述高置信度密钥格式；历史截图/全部原始证据尚未逐项做隐私复核，不能直接全部加入提交。
- Git姓名和邮箱已配置；当前没有非sample Git hook，未发现commit时自动执行推送的hook。本地提交时仍应复查配置没有改变。

## 建议：两个本地检查点，不重写几周历史

### 提交一：现有产品基线

推荐消息：`chore: checkpoint current implementation before revision 9`

仅收上述150个现有产品/测试/配置文件，包含A/B/C与revision1–8累计的tracked及untracked成果；不假装能将其准确拆成九轮历史提交。

范围来自apps/codex-broker、apps/studio、packages/production-pipeline、packages/workflow-core、src/video_factory、tests、scripts/deploy-production.sh、docker/Dockerfile、package.json、package-lock.json。正式stage前逐路径比较当前清单与r9基线，排除另一窗口刚发生的修改。

提交说明必须写：这是可追溯的WIP基线，已知revision8未到报价，存在R9-F01–08；此前全量通过是执行者报告，本窗口仅独立运行了导演校验探针并发现3项预期红灯。不能标release、accepted或ready for production。

### 提交二：当前修复资料与必要依据

推荐消息：`docs: define revision 9 repair scope and acceptance`

至少收当前TASK、REVIEW_REVISION8、IMPLEMENTATION_REVISION9、VALIDATION_REVISION9、LOCAL_COMMIT_PLAN、TASK_REVISION8归档、r9-start-baseline和r9-director-contract探针。

执行需要的旧ACCEPTANCE、RESULT、PROMPT_REVISION、最新QA文字报告以及r6/r7探针及其本地import依赖，经文本/隐私复核后一起纳入；不要让提交后的资料入口指向没有随提交保存的必读材料。历史大批截图与原始日志暂不纳入，原文件仍保留本机，报告标明其证据位置与未纳入提交状态。

不要为了让git status完全空白而删除未纳入文件、强制忽略全部docs，或把未审过的历史截图/日志一锅加入。产品源码有清楚基线，已足以让执行者准确审查本轮修改；剩余文档状态如实列出即可。

## 执行时的检查

1. 用户确认这两个范围后，在执行窗口尚未开工、没有并发写入时建立检查点；不重启正在运行的产品服务。
2. 复查HEAD、staged、文件hash、Git hook和候选清单。已有staged内容若非本计划范围，先报告，不覆盖。
3. 按明确路径stage，禁止无差别git add -A；检查staged差异、秘密/运行文件和git diff --cached --check。
4. 仅本地commit，不push、不amend历史、不改远程、不触发部署。失败要记录真实错误，不能强行跳过未知hook。
5. 报告两个commit hash、各自范围与保留未提交文件。执行窗口从新HEAD开工；r9-start-baseline文件hash仍有效，不覆盖旧基线伪造新证据。

## 本次确认后的执行记录

- 用户授权：在审查窗口提出“两笔本地提交、不推送、未复核历史截图和日志不纳入”的范围后，用户回复“确认”。仅限本次检查点，不延伸为执行窗口未来自动commit/push的权限。
- 提交一：`10592eb6538b8c2e755c1d3744764fd97be2246b`，`chore: checkpoint current implementation before revision 9`。150个产品/测试/配置文件，暂存内容逐一匹配r9基线；`git diff --cached --check`通过。没有修改产品内容，没有启动模型、媒体或部署。
- 提交二：本文件随`docs: define revision 9 repair scope and acceptance`保存。其hash由提交完成后的Git记录与审查窗口回报提供，不在文件中自引用尚未生成的hash。
- 第二笔精确范围共16个文件：本目录TASK、TASK_REVISION8、REVIEW_REVISION8、IMPLEMENTATION_REVISION9、VALIDATION_REVISION9、LOCAL_COMMIT_PLAN、ACCEPTANCE、RESULT、PROMPT_REVISION；evidence下r9-start-baseline.json、r9-director-contract.test.mjs、r9-handoff-checks.json、r9-director-red.txt、r6-contract-boundary-review.mjs、r7-capability-contract-review.mjs；以及docs/qa/videofactory-real-local-qa-20260913-07.md。
- 文本敏感格式复查的3处匹配均为r6/r7隔离测试中明确虚构的Provider key占位值；没有真实凭据匹配。格式检查不是全面隐私证明。没有读取.env或真实凭据文件。
- r6/r7本地import均指向已在仓库保存的产品源码或构建产物，无遗漏的文档脚本依赖。r7的可选capture-run测试依赖本机workspace里的历史run，该数据不提交；换机器时不能把缺少本地证据写成测试通过。
- 其余230个未跟踪文件保留原地：协作历史证据57、QA历史报告/截图137、旧R2修复包9、旧恢复包27。最新QA报告中的截图链接仍指向本机保留文件，不代表截图已进入Git。没有删除、移动或新增忽略规则来隐藏它们。
- 历史r9-handoff-checks.json保留“准备时未提交”的时间快照，不改写历史证据。执行窗口从完成这两笔后的最新HEAD开始；322个文件的r9基线hash仍适用。
- 本次不重跑全量产品测试：保存内容与已复核基线一致，没有产品代码改动。已有3项导演探针失败仍是待修复证据，不因commit变成通过。

后续是否公开仓库是独立决定，本地提交不等于允许公开或上传。
