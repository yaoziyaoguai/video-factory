import { stdin, stdout } from "node:process";
import { createPasswordHash } from "../apps/studio/src/server/auth.js";

if (stdin.isTTY) {
  throw new Error("请通过标准输入传入密码，避免密码进入终端历史。示例：printf '%s' '密码' | npm run --silent auth:hash");
}

stdin.setEncoding("utf8");
let password = "";
for await (const chunk of stdin) password += chunk;
password = password.replace(/[\r\n]+$/, "");
stdout.write(`${createPasswordHash(password)}\n`);
