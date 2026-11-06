import addFormatsModule from "ajv-formats";
import { Ajv2020 } from "ajv/dist/2020.js";
import { contractsSchema } from "../../shared/agent/generated/contracts-schema.js";

// ajv-formats 是 esbuild 产物的 CJS 模块（module.exports 上挂 .default）；
// NodeNext ESM 默认导入拿到模块命名空间，运行时再取 .default，类型走本地最小形状。
const addFormats = (addFormatsModule as unknown as { default: (ajv: Ajv2020, options?: unknown) => unknown }).default;

// 唯一 Schema 来源：contracts/agent/v1/contracts.schema.json 的生成副本。
// 校验器不联网解析引用，不做类型强制/默认补全/未知字段删除——未知字段由
// additionalProperties:false 直接拒绝。
const ajv = new Ajv2020({ strict: true, allErrors: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
addFormats(ajv);
ajv.addSchema(contractsSchema);

type ValidateFunction = {
  (value: unknown): boolean;
  errors: { instancePath?: string; message?: string }[] | null | undefined;
};

const compiled = new Map<string, ValidateFunction>();

export function validatorFor(schemaName: string): (value: unknown) => { ok: true } | { ok: false; message: string } {
  const cached = compiled.get(schemaName);
  if (cached) return wrap(cached);
  const validate = ajv.compile({ $ref: `https://frame.invalid/contracts/v1/payloads#/$defs/${schemaName}` }) as ValidateFunction;
  compiled.set(schemaName, validate);
  return wrap(validate);
}

function wrap(validate: ValidateFunction): (value: unknown) => { ok: true } | { ok: false; message: string } {
  return value => {
    if (validate(value)) return { ok: true };
    const errors = (validate.errors ?? []).map(error => `${error.instancePath || "/"} ${error.message ?? "invalid"}`).join("; ");
    return { ok: false, message: errors || "请求载荷不符合契约。" };
  };
}
