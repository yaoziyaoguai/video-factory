# 验证与 QA 方案

## 1. 基线与环境

```bash
cd /Users/jinkun.wang/work_space/veidofactory
git rev-parse HEAD
git status --short --branch
git diff --stat
git ls-files --others --exclude-standard
git diff --check
```

随后核对 Studio/Broker PID、命令、cwd、socket、health 和构建时间。不得读取、打印或写入 secret 内容。

## 2. 聚焦测试

根据最终落点运行并记录实际文件名；至少覆盖：

- Studio `CodexTopicIdeaModel` × Broker parser/validator 的真实合同测试。
- Broker accept/query/durable record/session 恢复。
- `CodexBridgeClient` HTTP/transport/error parsing。
- fallback client accepted/unknown 安全边界。
- role-agent-loop pending reconcile/checkpoint。
- ProductionPipeline 规划阶段恢复。
- Studio API/shared DTO/run retry/recovery。
- `TopicEntryWorkspace` 的总编统计、健康状态和恢复按钮。

所有新测试必须进入 `npm run test:ts`、`npm run test:broker` 或 `npm run studio:test` 的正式发现范围。

## 3. 必做故障注入

1. durable accepted 后丢弃结果响应。
2. executor running 时查询。
3. completed 后丢失 session registry。
4. 查询 socket 断开、超时和半包。
5. 完整 HTTP 400/409/500 与 JSON parse failure。
6. 同 requestId 不同 digest/session/kind/contract。
7. Studio 在 accepted 后重启，再从 checkpoint 查询。
8. Broker 在 accepted record 存在、terminal outcome 不可证明时重启，进入 `accepted_unknown`，不得重发。

测试用临时目录和 barrier；不能修改真实用户 durable record。只替换 executor，不替换正式协议、durable store、role loop 或 checkpoint。

## 4. 全量确定性回归

```bash
npm run build:pipeline
npm run test:ts
npm run studio:test
npm run test:broker
npm run test:package
npm run build
npm run typecheck
uv run pytest tests/
git diff --check
```

每条都必须有完整 exit code。timeout、截断输出、只看尾部或旧日志不算通过。已知孤儿 `apps/studio/test/editorial-decision.test.ts` 不能为了绿灯删除；应判断它是否已进入正式脚本、属于 stale 还是产品错误，并记录裁定。

## 5. 正式本地重启

确定性测试全绿后：

1. 只终止已核对 cwd/命令的旧 Studio/Broker 进程。
2. 重新 build 正式产物。
3. 使用现有正式 Codex Broker、ZAI Broker、Studio 生产构建和持久化 workspace。
4. 不创建 fake broker，不把测试 fixture 接入组合根。
5. 核对 Provider catalog、实际模型/effort、两个 reviewer identity、Python/ffmpeg/ffprobe/say。
6. 保留历史 run、checkpoint、Broker record。

## 6. 真实浏览器 QA

使用项目现有 QA 技能和真实 Web 点击，不直接改 JSON 或数据库跨过门禁。

第一遍策略：

- 从三个入口开始，尽量覆盖完整 E2E。
- 遇错记录页面、请求、run/node/requestId、Broker record、最新任务事实、观察错误、Provider receipt 和截图。
- 同类问题归到共同根因；原因可以同步调查，但不要每发现一个就停下来审计或部署。
- 仅当阻塞使剩余流程完全无法触达时，做最小解阻修复；否则测试完后集中修。

费用：

- 用户已授权本轮真实本地 E2E 中合理的图片/视频/素材/配音支出，可由执行者逐笔确认。
- 先核对报价、授权范围和是否已有可复用成果。
- 不用真实重复购买来测试幂等性；幂等故障用受控 executor/Provider fixture 验证。
- 单笔或累计出现数百元级异常预估时停止并报告。

## 7. QA 报告要求

新增报告建议路径：

`docs/qa/videofactory-real-local-qa-20260912-03.md`

至少包含：

- 环境与真实身份。
- 第一、二轮问题逐项复验。
- 三入口全链证据。
- 每项新问题的严重度、复现、预期/实际、共同根因、是否阻断、费用影响。
- run/requestId/digest/session/Broker outcome 的关联，不记录秘密。
- Provider 调用、授权、ledger 和实际费用。
- 视频 ffprobe、逐段有画面、声音与字幕证据。
- 双审 identity/evidence SHA/独立报告。
- 1440/390 截图索引。
- 未验证项与原因。

修完 QA 新问题后，重复聚焦与全量回归，并只重测受影响和高风险邻接流程；不需要为每个小修重新买一整条视频。

