import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dirname, "../..");
const files = execFileSync("rg", ["--files", "apps/studio/src/client", "-g", "*.ts", "-g", "*.tsx"], {
  cwd: root,
  encoding: "utf8",
}).trim().split("\n").sort();

const ignoredAttributes = new Set(["className", "id", "key", "href", "src", "to", "target", "rel", "type", "name", "htmlFor", "data-testid"]);
const rows = [];
for (const file of files) {
  const source = readFileSync(resolve(root, file), "utf8");
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  function visit(node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node)) {
      const parent = node.parent;
      const attribute = ts.isJsxAttribute(parent) ? parent.name.text : undefined;
      const importLike = ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent);
      const text = node.text.replace(/\s+/g, " ").trim();
      const humanText = /\p{Script=Han}/u.test(text) || (attribute && ["aria-label", "title", "placeholder", "alt"].includes(attribute));
      if (!importLike && !ignoredAttributes.has(attribute) && humanText && text) {
        const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
        rows.push({ file, line, kind: ts.isJsxText(node) ? "JSX" : attribute ? `attribute:${attribute}` : "literal", text });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
}

const seen = new Set();
const lines = [
  "# VideoFactory 界面文案静态清单（机械抽取）",
  "",
  "范围：apps/studio/src/client 下全部 TS/TSX。包含中文字符串、JSX 文本和少量可访问性属性；不代表每条都一定可见。动态服务端内容、模板插值、英文错误和运行条件需另行核对。文件位置为源码行号。未包含用户数据或环境变量。",
  "",
];
for (const row of rows) {
  const key = `${row.file}\0${row.text}`;
  if (seen.has(key)) continue;
  seen.add(key);
  lines.push(`- ${row.file}:${row.line} [${row.kind}] ${JSON.stringify(row.text)}`);
}
lines.push("");
writeFileSync(resolve(import.meta.dirname, "COPY_INVENTORY.md"), lines.join("\n"));
console.log(`files=${files.length} occurrences=${rows.length} unique-file-text=${seen.size} output=${lines.join("\n").length} chars`);
