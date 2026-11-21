import type { AgentServiceOptions } from "../../src/server/agent/agent-service.js";

// 快照/分页/SSE 握手层测试的服务装配：这些路径只读数据库与目录常量，
// 不启动 Pi 运行时。未被使用的重依赖以显式抛错的占位填充——误用时测试会立刻失败，
// 而不是静默返回空结果。models/skills/displayName 是快照 Bootstrap 真实读取的字段，给真值。
export function offlineServiceOptions(base: Pick<AgentServiceOptions, "db" | "clock" | "hub">): AgentServiceOptions {
  const unused = () => { throw new Error("本测试不使用该依赖。"); };
  return {
    ...base,
    host: unused as unknown as AgentServiceOptions["host"],
    registry: unused as unknown as AgentServiceOptions["registry"],
    catalog: unused as unknown as AgentServiceOptions["catalog"],
    models: [],
    defaultTextBinding: () => null,
    skills: () => [],
    displayName: "离线测试",
  };
}
