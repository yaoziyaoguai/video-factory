# Loop 9 Result: Publishable Production Slice

Date: 2026-08-21

## Outcome

Loop 9 的发布前技术闭环完成。一个 `video-factory/brief-v1` 可以驱动 TS workflow 调用 Python worker，生成真实有声竖屏 MP4，在人工终审处持久化暂停，并由另一个 CLI 进程批准或拒绝。批准后生成带完整审计信息的发布包，且不会重跑前序媒体节点。

这不是市场验证完成。播放量、涨粉和日更能力仍需要 Loop 10 的真实平台发布数据。

## Closed Capabilities

- versioned brief 与 worker JSON protocol；stdout 始终只有一个结构化响应。
- capability-scoped provider binding；素材 provider 可通过 brief 替换。
- script、asset、voice、render、technical review、human review、publish package 节点。
- 首个 worker 前创建 run manifest，每个节点后 checkpoint。
- 跨进程人工 `approve/reject`，并发决定在同一 run transaction 内串行化。
- attempt 目录边界、artifact SHA-256/大小复算、发布前二次完整性校验。
- 子进程超时会终止 Python worker 及其 FFmpeg/`say` 后代。
- H.264/AAC、1080x1920、非静音、目标时长、分镜覆盖和 production asset 技术门禁。

## Review Findings Applied

- 修复发布包文件字节与 artifact hash/size 不一致。
- 修复 provider ID 跨 capability 误绑定。
- 保留被技术门禁拒绝的 review artifact。
- 把 revision 检查前移到包含发布包副作用的 run transaction。
- 增加孤儿锁回收、运行中 checkpoint 和 worker process-group 清理。
- 收紧人工动作合同，去掉尚未实现的 `edit/choose_provider/replace_asset`。
- 对 worker artifact 做协议字段、路径、hash 和大小校验。
- 纠正 10 秒 brief 实际最少渲染 20 秒的合同矛盾，当前范围为 20-180 秒。
- 纠正 artifact lineage，parallel voice 节点不再继承 assets 等无关父产物。

独立 validator 否决了“schemaVersion 必须由 Python worker 自报”的 finding。当前 TS 根据 artifact kind 统一生成 schema version，未违反已定义协议，因此没有增加重复字段。

## Real Sample

- Run: `run-d8ed8ff7-2ba1-470b-8ad1-e1af6dab1f56`
- Status: `succeeded`, revision `1`
- Human actor: `codex-director-review`
- Video: `workspace/factory/runs/run-d8ed8ff7-2ba1-470b-8ad1-e1af6dab1f56/nodes/render/attempt-1/renders/1/final.mp4`
- Technical review: `passed`, max volume `-6.5 dB`, zero failed checks
- Media: 24.33 seconds, 1080x1920, H.264 video, AAC stereo audio
- Publish package SHA-256 and byte count match the persisted file.

## Verification

- `make test`: Python 28/28 passed; TS 32 passed, 1 real-media test skipped in the fast suite; package entrypoint 3/3 passed.
- `make test-e2e`: 1/1 passed using real `say`, FFmpeg and ffprobe processes.
- `git diff --check`: passed.
- Source directories contain no generated `.js`, `.d.ts` or `.js.map` files.
- Independent code review covered correctness, reliability, security, contracts, maintainability, tests and agent-native operation. All validated Loop 9 blockers were fixed and rerun.

## External Gate

Loop 10 必须由真人完成以下动作：

1. 在同一个真实账号连续发布 3 条通过终审的视频。
2. 记录每条的 run id、post id/URL 和发布时间。
3. 在 T+24h 回填播放、完播、新增关注等真实指标。
4. 数据闭环后再决定扩赛道、agent tool surface、Studio UI、商业 TTS 或自动发布。
