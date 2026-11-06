# Frame Agent v1 接口索引

工作台 API 前缀是 `/api/agent/v1`。当前契约修订 **0.1.32**；HTTP 操作以 [OpenAPI](openapi.json) 为准，HTTP、SSE、Pi 工具和领域对象的结构以 [JSON Schema](contracts.schema.json) 为准。

| 文件 | 用途 |
| --- | --- |
| [agreement.md](agreement.md) | 请求、交付、授权、快照与事件的语义 |
| [openapi.json](openapi.json) | 各路由的方法、参数、状态码与响应引用 |
| [contracts.schema.json](contracts.schema.json) | 领域对象、命令、错误与工具输入输出 |
| [examples.json](examples.json) | 合法与拒绝的固定示例（合成数据） |
| [consumer-example.ts](consumer-example.ts) | 使用派生类型的示例 |
| [ports.ts](../../../apps/studio/src/shared/agent/ports.ts) | TypeScript 端口与调用边界 |

在**仓库根目录**运行 `npm run contracts:check`。改动 Schema 后运行 `npm run contracts:generate`，提交权威文件和 [派生类型及运行时 Schema](../../../apps/studio/src/shared/agent/generated/)；不要直接编辑生成文件。检查是离线的，不验证真实供应商的帐号或计费。

日常操作先读 `GET /bootstrap`，再读取会话快照。设置、素材、作品库和制作记录各有独立操作，订阅则使用会话的 `/events`。登录走 `/api/auth/session` 和 `/api/auth/login`；部署探针走 `/api/health`，不属于此业务协议。
