# ADR 002: Local Production Runtime And Python Worker Protocol

Date: 2026-08-21

## Status

Accepted and implemented in Loop 9.

## Context

Loop 8 建立了 TS workflow-core，Python 原型也已经能生成 MP4，但两者是两条平行链：TS run 只在内存中存在，Python CLI stdout 面向人类，人工暂停后不能跨进程恢复，成片还是静音。

当前产品目标是让一个人每天可靠生产一条视频。这个阶段不需要分布式队列或完整 agent runtime，但必须有真实媒体、稳定协议、持久化状态和人工终审。

## Decision

- 保留 `@video-factory/workflow-core` 作为领域状态机。
- 增加 `@video-factory/production-pipeline`，负责本地 FileRunStore、provider binding、Python worker adapter 和生产 CLI。
- Python 通过 `video-factory/worker-v1` JSON 协议提供 script、asset、voice、render 和 technical review capability。
- stdout 只输出一个 JSON response；诊断属于 stderr。
- TS 是 run 状态唯一所有者；Python 只写隔离 attempt 目录中的媒体 artifact。
- 人工决定在单个 run lock 内完成 load、resume、发布包写入和 revision 更新，批准后从暂停节点继续，不重跑前序媒体节点。
- workflow 在首个 worker 启动前创建 `run.json`，并在每个节点结束后 checkpoint；进程中断后仍可看到最后完成状态。
- worker artifact 必须位于当前 attempt 目录，TS 会独立复算 SHA-256 和大小；生成发布包前再次校验所有文件型 artifact。
- 默认免费路径使用 local editorial cards 和 macOS `say`；Pexels/Pixabay 作为可选 asset provider。

## Consequences

收益：

- 一条命令可以生成真实非静音 1080x1920 MP4，并留下完整 provenance。
- 人工终审可以跨进程 approve/reject。
- 并发、重复或过期决定不会在 revision 检查前重复执行发布包副作用。
- provider 由 brief 绑定，不需要改 workflow。
- 技术质检读取真实 ffprobe/volumedetect 结果。

约束：

- FileRunStore 当前针对单机运行，不是分布式调度器；锁记录 owner，并只回收已确认失效的本机进程锁。
- 自动节点中断后会留下 `running` checkpoint，但本轮不自动重试未完成节点。
- `macos-say` 只适合本地冷启动，声音品质需要真实数据验证后再决定是否替换。
- 自动发布和指标抓取不在本 ADR 范围内。

## Next Decision

只有连续 3 条真实发布和 T+24h 指标回流完成后，才决定 Studio UI、Remotion、商业 TTS、队列和 agent runtime 的优先级。
