// 仓库内契约检查器：由 2026-10-25 交接目录 implementation/video-agent-v1/verify.mjs 迁移。
// 差异：契约权威已在仓库（contracts/agent/v1/），类型与运行时 Schema 生成到
// apps/studio/src/shared/agent/generated/；工具依赖来自仓库根 package.json，不联网解析引用。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { checkPolicyExamples } from "./check-policy-examples.mjs";

const contractRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(contractRoot, "..", "..", "..");
const args = process.argv.slice(2);
const localRequire = createRequire(join(repoRoot, "package.json"));
const versions = {};
for (const [name, expected] of [
  ["ajv", "8.20.0"], ["ajv-formats", "3.0.1"],
  ["typescript", "5.9.3"], ["json-schema-to-typescript", "15.0.4"],
]) {
  const actual = localRequire(`${name}/package.json`).version;
  if (actual !== expected) throw new Error(`${name}: expected ${expected}, found ${actual}; check root package.json pins`);
  versions[name] = actual;
}

const schema = JSON.parse(readFileSync(join(contractRoot, "contracts.schema.json"), "utf8"));
const api = JSON.parse(readFileSync(join(contractRoot, "openapi.json"), "utf8"));
const examples = JSON.parse(readFileSync(join(contractRoot, "examples.json"), "utf8"));
const Ajv = localRequire("ajv/dist/2020.js").default;
const ajv = new Ajv({ strict: true, allErrors: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
localRequire("ajv-formats")(ajv);
ajv.addSchema(schema);

// 仅本地引用；绝不把契约中的地址当联网或执行指令。
let referenceCount = 0;
function checkReferences(value, document) {
  if (!value || typeof value !== "object") return;
  if (typeof value.$ref === "string") {
    referenceCount++;
    let target = document;
    let fragment = value.$ref;
    if (fragment.startsWith("./contracts.schema.json#")) {
      target = schema;
      fragment = fragment.slice("./contracts.schema.json".length);
    } else if (!fragment.startsWith("#/")) throw new Error(`Non-allowlisted reference: ${fragment}`);
    for (const part of fragment.slice(2).split("/")) {
      const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
      if (!Object.hasOwn(target, key)) throw new Error(`Unresolved reference: ${value.$ref}`);
      target = target[key];
    }
  }
  for (const child of Object.values(value)) checkReferences(child, document);
}
checkReferences(schema, schema);
checkReferences(api, api);

const validators = new Map(Object.keys(schema.$defs).map(name => [name,
  ajv.compile({ $ref: `${schema.$id}#/$defs/${name}` }),
]));
const failures = [];
for (const example of examples) {
  const validate = validators.get(example.schema);
  if (!validate) throw new Error(`Unknown example schema: ${example.schema}`);
  const before = JSON.stringify(example.value);
  const passed = validate(example.value);
  if (passed !== example.valid) failures.push({ name: example.name, expectedValid: example.valid, errors: validate.errors });
  if (before !== JSON.stringify(example.value)) throw new Error(`Validator mutated fixture: ${example.name}`);
}
if (failures.length) throw new Error(JSON.stringify(failures, null, 2));

const ids = new Set();
const referencedPayloads = new Set();
for (const [path, pathItem] of Object.entries(api.paths)) {
  for (const [method, operation] of Object.entries(pathItem)) {
    if (ids.has(operation.operationId)) throw new Error(`Duplicate operationId: ${operation.operationId}`);
    ids.add(operation.operationId);
    for (const match of path.matchAll(/\{([^}]+)\}/g)) {
      if (!operation.parameters?.some(p => p.in === "path" && p.name === match[1] && p.required)) throw new Error(`Missing path parameter: ${path}`);
    }
    if (["post", "patch"].includes(method)) {
      const requestRef = operation.requestBody.content["application/json"].schema.$ref;
      const name = requestRef.split("/").at(-1);
      const payload = schema.$defs[name];
      // 原生包管理不产生命令回执；仅这两个精确操作/路径/写体例外，旧命令仍逐分支检查幂等身份。
      const isSkillPackageMutation = method === "post" && (
        (path === "/settings/skills/install" && operation.operationId === "installSkillPackage" && name === "InstallSkillPackage") ||
        (path === "/settings/skills/remove" && operation.operationId === "removeSkillPackage" && name === "RemoveSkillPackage")
      );
      const branches = (payload.oneOf ?? [payload]).map(branch => branch.$ref ? schema.$defs[branch.$ref.split("/").at(-1)] : branch);
      if (!isSkillPackageMutation && !branches.every(branch => branch.required?.includes("commandId"))) throw new Error(`Mutation without idempotency identity: ${operation.operationId}`);
      if (!operation.parameters.some(p => p.name === "Origin" && p.required)) throw new Error(`Missing Origin requirement: ${operation.operationId}`);
      referencedPayloads.add(name);
    }
    for (const response of Object.values(operation.responses)) {
      const payload = response.content?.["application/json"]?.schema?.$ref?.split("/").at(-1);
      if (payload) referencedPayloads.add(payload);
    }
  }
}
for (const name of referencedPayloads) {
  if (!examples.some(e => e.schema === name && e.valid)) throw new Error(`No valid consumer fixture for HTTP payload ${name}`);
}

for (const kind of schema.$defs.BusinessEvent.properties.kind.enum) {
  const mapping = api["x-event-read-models"][kind];
  if (!mapping) throw new Error(`Event has no read model: ${kind}`);
  const operation = Object.values(api.paths).flatMap(item => Object.values(item)).find(item => item.operationId === mapping.readOperation);
  if (!operation) throw new Error(`Missing event read operation: ${kind}`);
  let field = schema.$defs[operation.responses["200"].content["application/json"].schema.$ref.split("/").at(-1)];
  for (const segment of mapping.versionField.split(".")) {
    if (field.$ref) field = schema.$defs[field.$ref.split("/").at(-1)];
    field = field.properties?.[segment];
    if (!field) throw new Error(`Event read model has no version: ${kind}`);
  }
  if (field.type !== "integer") throw new Error(`Event version is not comparable: ${kind}`);
}
const policyChecks = checkPolicyExamples(api);

const generatorSchema = structuredClone(schema);
// 类型生成归一化：allOf/if/then/else 的条件分支属性并入基础字段全集（只补充缺失字段，
// 不改 required、不覆盖既有定义）；条件语义（steer 绑定、feedback 状态等）仍由运行时
// Ajv 用完整 Schema 强制。不做归一化时 json-schema-to-typescript 会退化为索引签名或 unknown。
const mergeInto = (target, source) => {
  if (!source || typeof source !== "object" || Array.isArray(source)) return;
  for (const [key, value] of Object.entries(source.properties ?? {})) {
    if (!target.properties) target.properties = {};
    if (!Object.hasOwn(target.properties, key)) target.properties[key] = value;
  }
};
const normalize = (node) => {
  if (Array.isArray(node)) { for (const item of node) normalize(item); return; }
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node.allOf)) {
    for (const item of node.allOf) { normalize(item); mergeInto(node, item); }
    delete node.allOf;
  }
  if (node.then) { normalize(node.then); mergeInto(node, node.then); }
  if (node.else) { normalize(node.else); mergeInto(node, node.else); }
  delete node.if; delete node.then; delete node.else;
  for (const value of Object.values(node)) normalize(value);
};
normalize(generatorSchema.$defs);
for (const [name, definition] of Object.entries(generatorSchema.$defs)) definition.title = name;
// 用无业务含义的根容器使每个公开/私有边界类型都有稳定名称；所有字段仍来自唯一 Schema。
generatorSchema.type = "object";
generatorSchema.title = "ContractPayloads";
generatorSchema.additionalProperties = false;
generatorSchema.properties = Object.fromEntries(Object.keys(schema.$defs).map(name => [name, { $ref: `#/$defs/${name}` }]));
generatorSchema.required = Object.keys(schema.$defs);
const { compile } = localRequire("json-schema-to-typescript");
const generatedTypesPath = join(repoRoot, "apps/studio/src/shared/agent/generated/contracts.ts");
const generatedSchemaPath = join(repoRoot, "apps/studio/src/shared/agent/generated/contracts-schema.ts");
const generated = await compile(generatorSchema, "ContractPayloads", {
  bannerComment: "/* Generated by contracts/agent/v1/verify.mjs. Edit contracts.schema.json, then npm run contracts:generate. */",
  cwd: contractRoot, unreachableDefinitions: true, maxItems: -1,
  $refOptions: { resolve: { http: false, file: false } },
});
const generatedSchemaModule = [
  "// 运行时校验用的唯一 Schema 来源副本；由 contracts/agent/v1/verify.mjs 生成，勿手改。\n",
  "export const contractsSchema: Record<string, unknown> = ",
  JSON.stringify(schema, null, 2) + ";\n",
  "export default contractsSchema;\n",
].join("");
if (args.includes("--generate")) {
  writeFileSync(generatedTypesPath, generated);
  writeFileSync(generatedSchemaPath, generatedSchemaModule);
}
if (!existsSync(generatedTypesPath) || readFileSync(generatedTypesPath, "utf8") !== generated) {
  throw new Error("Generated types drift; run npm run contracts:generate after reviewing contract changes.");
}
if (!existsSync(generatedSchemaPath) || readFileSync(generatedSchemaPath, "utf8") !== generatedSchemaModule) {
  throw new Error("Generated runtime schema drift; run npm run contracts:generate after reviewing contract changes.");
}

const ts = localRequire("typescript");
const options = { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, skipLibCheck: false, types: [] };
const program = ts.createProgram([
  generatedTypesPath, generatedSchemaPath,
  join(repoRoot, "apps/studio/src/shared/agent/ports.ts"),
  join(contractRoot, "consumer-example.ts"),
], options);
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCurrentDirectory: () => repoRoot, getCanonicalFileName: x => x, getNewLine: () => "\n" }));

const hashFiles = ["agreement.md", "contracts.schema.json", "openapi.json", "examples.json", "check-policy-examples.mjs", "verify.mjs", "consumer-example.ts"];
const result = {
  status: "passed", scope: "offline schemas, local refs, HTTP wiring, fixtures and derived TypeScript; no implemented provider or end-to-end validation",
  versions, schemaCount: validators.size, httpOperationCount: ids.size, checkedReferences: referenceCount,
  positiveFixtures: examples.filter(x => x.valid).length, negativeFixtures: examples.filter(x => !x.valid).length,
  policyChecks,
  providerResponsesValidated: false, realProductModelCalls: 0, realMediaCalls: 0,
  generated: { types: "apps/studio/src/shared/agent/generated/contracts.ts", runtimeSchema: "apps/studio/src/shared/agent/generated/contracts-schema.ts" },
  hashes: Object.fromEntries([
    ...hashFiles.map(name => [name, createHash("sha256").update(readFileSync(join(contractRoot, name))).digest("hex")]),
    ["../../package.json", createHash("sha256").update(readFileSync(join(repoRoot, "package.json"))).digest("hex")],
    ["../../apps/studio/src/shared/agent/ports.ts", createHash("sha256").update(readFileSync(join(repoRoot, "apps/studio/src/shared/agent/ports.ts"))).digest("hex")],
  ]),
};
mkdirSync(join(contractRoot, "evidence"), { recursive: true });
writeFileSync(join(contractRoot, "evidence/contract-check.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ ...result, hashes: "recorded in contracts/agent/v1/evidence/contract-check.json" }, null, 2));
