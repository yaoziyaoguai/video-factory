# Loop 10 Results: Web Operator Studio

Date: 2026-08-21
Status: Complete

## Outcome

VideoFactory 现在具备可日常使用的本地 Web Studio。操作员可以在生产队列创建真实视频任务，实时观察工作流，在浏览器播放 9:16 成片，并批准生成发布包或填写原因打回。CLI 仍保留，但不再是日常操作的必要入口。

## Real Run Evidence

- Web 创建并批准：`run-1a18987b-5106-4b66-99bc-b05b7b907f9c`，最终状态 `succeeded`，发布包已生成。
- 内容一致性修复后人工打回：`run-cf5ab315-429a-4933-95e7-7774577628df`，最终状态 `rejected`，revision 1，审片原因持久化。
- 同一打回重复提交返回 `409 Conflict`，未产生第二个决定。
- 修复后的通用 24 秒 brief 生成 24.833 秒 MP4，1080x1920、H.264/AAC、音频最大音量 -6.3 dB，技术审片全部通过。
- 浏览器媒体检查：`readyState=4`、`videoWidth=1080`、`videoHeight=1920`；真实 Range 请求返回 `206 Partial Content`。

## Review Fixes

- 修复生产构建与开发模式的 workspace 依赖顺序。
- 修复编译态仓库根路径解析。
- 修复 HTML pattern 控制台错误与 favicon SPA 回退。
- 修复移动端工作流只显示前四个节点。
- 修复打回成功后对话框残留和重复按钮重新可用。
- 区分技术门禁拒绝与人工打回文案。
- 修复 `life-avoidance` 旁白忽略用户标题的问题。
- 收紧通用短视频旁白长度，使 24 秒 brief 不再渲染成约 38 秒。

## Verification

- `npm test`: 35 TS tests passed, 1 opt-in real E2E skipped here; 4 client tests, 11 Studio server/service tests, 3 package tests passed; typecheck and production build passed.
- `make test-py`: 29 Python tests passed.
- `make test-e2e`: real FFmpeg/macOS say/ffprobe E2E passed in 10.26 seconds.
- 一次性 Playwright 会话（未落仓为回归套件）：桌面 1440x1000 检查 queue、new-run drawer、waiting review、succeeded/rejected review 和能力状态。
- 同一次 Playwright 会话：移动端 390x844 检查完整 8 节点流程、视频、产物和能力状态。
- Final clean browser session: 0 console errors and 0 warnings.
- `git diff --check`: passed.

Screenshots are stored under ignored `output/playwright/loop-10/`. Generated media and run manifests remain under ignored `workspace/factory/`.

## Remaining Product Boundary

The Web Studio and production control plane are complete for this loop. The local editorial renderer is still a baseline visual provider; stock footage, stronger art direction, topic intelligence, metrics feedback, and platform publishing remain separate product loops rather than hidden claims of this delivery.
