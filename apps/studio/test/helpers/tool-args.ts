import type { ProductionIntent, ProjectRenderRequestOperation, ToolProductionIntent, ToolRenderProject } from "../../src/shared/agent/generated/contracts.js";
import type { AgentRuntime } from "../../src/server/agent/assembly.js";
import { probeRenderInputs } from "../../src/server/agent/media-probe.js";
import { validatorFor } from "../../src/server/agent/validate.js";
import { AgentError } from "../../src/server/agent/errors.js";
import { finalVideoTarget } from "./creative-work-fixture.js";

// prepare_production 的合同输入不含服务端定价字段：创建次数、单价、价格种类由目录在准备阶段展开。
// 测试脚本用完整的 ProductionIntent 描述预期图，发送前按合同剥掉这几个字段；
// 剩余形状仍经工具边界的严格校验，不做第二份手写 DTO。
export function toolIntentOf(intent: ProductionIntent): ToolProductionIntent {
  return {
    ...intent,
    operations: intent.operations.map(operation => {
      const { maxCreateAttempts: _attempts, quotePerAttempt: _quote, priceKind: _price, ...rest } = operation as Record<string, unknown>;
      return rest;
    }),
  } as unknown as ToolProductionIntent;
}

// DGR-03：纯本地行为用例改走本地受理，保留原输入/参数断言，不再造 ¥0 提案与授权。
export function localRenderIntentOf(intent: ProductionIntent): ToolRenderProject {
  if (intent.workId === null) throw new Error("本地渲染夹具需要真实 workId");
  const localOperation = (operation: ProductionIntent["operations"][number]): ProjectRenderRequestOperation => {
    if (operation.kind !== "render" || operation.model !== null) throw new Error("付费操作不能混入本地夹具");
    const target = operation.operationId === intent.finalOutput.operationId ? intent.outputTarget ?? finalVideoTarget()
      : { group: { mode: "create" as const, key: "intermediate", title: "中间片段", nextIntent: null },
        item: { mode: "create" as const, key: operation.operationId, label: operation.operationId, role: "clip" as const, required: false } };
    return { operationId: operation.operationId, outputSlot: operation.outputSlot, inputs: operation.inputs,
      parameters: operation.parameters, target };
  };
  const [first, ...rest] = intent.operations;
  return { workId: intent.workId, title: intent.title, scope: intent.scope, purpose: intent.purpose,
    inputSources: intent.inputSources, reviewInputs: intent.reviewInputs, operations: [localOperation(first), ...rest.map(localOperation)] };
}

export async function admitLocalIntent(
  runtime: Pick<AgentRuntime, "database" | "production">,
  scope: { ownerId: string; conversationId: string },
  intent: ProductionIntent,
  probe = true,
) {
  const input = localRenderIntentOf(intent);
  const verdict = validatorFor("ToolRenderProject")(input);
  if (!verdict.ok) throw new AgentError("INVALID_INPUT", verdict.message);
  const request = runtime.database.prepare("SELECT id AS requestId, message_id AS messageId FROM requests WHERE owner_id=? AND conversation_id=? ORDER BY rowid DESC LIMIT 1")
    .get(scope.ownerId, scope.conversationId) as { requestId: string; messageId: string } | undefined;
  if (!request || !runtime.production) throw new Error("本地受理夹具缺少真实请求或 production");
  const probes = probe ? await probeRenderInputs(runtime.database, runtime.production.blobs, scope, input) : undefined;
  return runtime.production.admitLocalRender(scope.ownerId, scope.conversationId, request, input, probes);
}
