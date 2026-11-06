import type { ProductionIntent, ToolProductionIntent } from "../../src/shared/agent/generated/contracts.js";

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
