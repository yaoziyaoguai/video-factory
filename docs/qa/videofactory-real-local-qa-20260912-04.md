# VideoFactory 第四轮真实本地 QA 报告（R3 收口）

- 报告编号：`VF-REAL-LOCAL-QA-20260912-04`
- 日期：2026-09-12
- 分支：`codex/final-dual-review-cloud-acceptance`
- HEAD：`570fe6e59e072c4965c86769bf2096825f003383`
- 结论：确定性修复回归通过；真实本地 E2E 被规划阶段的审计耗尽和原任务结果未知阻断，未进入媒体报价、付费、配音、渲染或双审。

## 1. 正式本地环境

- OpenAI Broker：PID 41763，socket `.local/runtime/codex/worker.sock`，Provider `openai`，model `gpt-5.6-sol`。
- ZAI Broker：PID 41764，socket `.local/runtime/zai-codex/worker.sock`，Provider `zai-bigmodel-api`，model `glm-5.3`。
- Studio：PID 90503，`http://127.0.0.1:4317`，生产构建；health 返回 ok，Python/FFmpeg/ffprobe/say 均为 true。
- 浏览器：复用已登录的本地 QA 浏览器；独立 Playwright 会话遇生产登录门禁，未读取或绕过凭据。
- 未挂接 fake Broker，未修改数据库制造通过，未输出凭据。

## 2. 已验证修复

### Asset-rank 请求合同

`planningIntent` 只参与 checkpoint 身份，不再展开进入 Broker 严格请求；正式 Broker 合同测试覆盖真实 asset-rank 边界。此前真实 400 根因已消除。

### 图库来源无实质进展时停止循环

同类图库可得性阻断第一次允许调整路线，第二次仍无实质进展则转 `needs_source`，不再进入第三组 director/search/rank。界面给出上传/实拍、改成概念表达、停止制作三类人工动作，并明确 AI 图不能冒充真实实验。

### Broker 受理、绑定和恢复

正式套件已覆盖 immutable binding、同 ID 单执行者、accepted/unknown 与查询故障分离、session 恢复、丢失 POST 回包后的原任务取回、错误完成身份拒绝和后台落盘生命周期。隔离审计由初始 0/12 修复为 12/12。

## 3. 真实 E2E 结果

### 系列入口：三轮编剧审计耗尽

- runId：`run-41860eb5-9898-41f7-986e-88c2236a33a9`
- 主题：赶出门前开飞行模式，15 分钟真的能多充电吗？
- 结果：`failed`，停在 `creative-planning`；媒体 create=0，费用 ¥0.00。
- 时间：`2026-09-12T12:39:04.471Z` 至 `2026-09-12T12:55:43.495Z`，总计 16 分 39 秒。
- 最终阻断：场景 1 改写后前两秒没有明确点出比较对象是正常联网与飞行模式，无法兑现上游具体钩子。
- 页面能展示最后独立审计摘要、已保留的前序结果和未开始画面/未产生费用；但仍显示“重试失败步骤”，没有证明外层重试不会重新获得三轮额度。
- 截图：`06-series-script-audit-exhausted-1440.png`。

### 概念入口：原任务结果未知，停止继续等待

- runId：`run-97298ba0-f2ff-4c38-a201-67c447235429`
- 主题：把拖延画成一间不断缩小的房间。
- Treatment 已通过，score 94；随后编剧阶段长期运行。
- 安全调用“查询原任务”返回 `accepted_unknown`，`allowedActions=[query_original_task]`，明确没有重新提交；观察错误为连接中断、结果未知。
- 页面刷新后仍显示“第 1/3 轮：正在生成候选交付”，已观察到约 19 分 20 秒；没有显示 API 已允许的“查询原任务”动作。轮次投影还曾从第 2/3 轮审计回到第 1/3 轮生成，用户无法理解真实进度。
- 媒体 create=0，费用 ¥0.00；未继续等待、未普通重试、未创建新 run。
- 截图：`07-concept-stuck-after-query-1440.png`、`08-concept-stuck-after-refresh-390.png`。刷新后浏览器 console 无错误。

### 旧长耗时案例

- runId：`run-1e12feb7-19e2-4d66-b126-8e3b974c9bd0`
- 总耗时约 65 分 49 秒，其中一次恢复约 15 分 57 秒。
- 恢复串行执行 `rank → director → rank → director → rank`；导演前期约 5.1 分钟、编剧约 12.3 分钟、三组导演约 20.2 分钟、三组候选排序约 4.1 分钟。
- 原问题指纹包含镜头/query/artifact，使同类来源阻断被误认为新问题。本轮已修同类图库阻断的“无实质进展”判定。
- 截图：`05-manual-gate-no-blind-retry-1440.png`。

## 4. 长耗时拆解与原因

| 案例/阶段 | 实际耗时 | 原因 |
| --- | ---: | --- |
| 系列 run 总计 | 16 分 39 秒 | 编剧完整走完 3 轮；每轮包含 produce + 独立 audit。 |
| 编剧 produce 合计 | 466237 ms | 三轮分别 229217 / 108745 / 107984 ms。 |
| 编剧 audit 合计 | 474343 ms | 三轮分别 180184 / 160813 / 93915 ms。 |
| 编剧 queue 合计 | 约 56803 ms | OpenAI 单 worker 排队；第二、三轮约 38340 / 18463 ms。 |
| 概念 run | 至少 19 分 20 秒 | Treatment 后进入 GLM 编剧；Studio 重启后 pending task 投影为 accepted_unknown，安全查询仍无法取得终态。 |
| 旧 run | 约 65 分 49 秒 | 来源阻断被当成不同问题，重复串行 director/rank；这是已修的无进展循环根因。 |

这些耗时不是“正常等待”。当前角色内部虽有 3 轮上限，但单轮真实模型可能耗时数分钟，且 checkpoint/恢复、不同角色和外层重试没有统一的视频级机会预算，用户仍可能长时间悬挂。

## 5. 产品缺口记录（本轮不扩大实现）

建议后续以“单个视频 × 单个角色”为预算单位：每个角色总共最多 3 次机会，即 1 次自动创建 + 最多 2 次审计/修订。外层打回同一角色不得通过新 checkpoint 重新获得三次机会。

达到上限后应直接进入人工介入状态，展示：最后一次独立审计的具体阻断、已保留成果、可执行的人工动作（人工改稿/上传或实拍/改为明确的概念表达/停止制作）。不能继续重复“候选不足”，也不能让普通重试暗中刷新额度。该交互仍需产品设计，本轮未擅自重构。

当前已确认缺口：

- 全局“单视频 × 单角色”三次机会预算未实现或未获证据证明。
- 系列 run 审计耗尽后仍出现普通重试入口。
- 概念 run 的 API 已投影 `query_original_task`，页面在 running/unknown 状态没有显示该动作。
- 长任务的轮次展示可能倒退，无法表达真实等待原因和剩余机会。

## 6. 验证与未验证

已完成并成功：`npm run test:broker` 188/188、`npm run studio:test`（Vitest 377/377 + Node 482/482）、`npm run typecheck`、`npm run build`、`npm run test:package` 3/3、`build:pipeline`、Python unittest 131/131、隔离审计 12/12、`git diff --check`。`npm run test:ts` 的完整一轮为 765 pass / 0 fail / 1 skip；该轮未单独捕获 shell exit marker。

未验证：项目虚拟环境没有 pytest 模块，`.venv/bin/python -m pytest` 以 `No module named pytest` 退出 1，未安装或升级依赖。真实完整成片、媒体 Provider taskId、配音、渲染、同 SHA 双模型审片、用户打回和局部返工均未走到，不能记为通过。

最后为响应用户立即收口而启动后取消的 `test:broker` / `test:ts` 重复运行属于人为中断，不能作为失败或通过证据；上文引用的是此前已经完整结束的回归。

## 7. 外部副作用

- 媒体授权：0 笔。
- Provider 媒体 taskId：无。
- 实际媒体费用：¥0.00。
- 未 commit、未 push、未部署云端、未删除 durable/checkpoint 或用户数据。
