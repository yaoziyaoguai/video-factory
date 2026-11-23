import { openAgentDatabase } from "../apps/studio/dist/server/server/agent/db.js";
import { rotateCredentialSecret } from "../apps/studio/dist/server/server/agent/credential-cipher.js";

const { AGENT_DATA_DIR, FRAME_CREDENTIAL_SECRET, FRAME_NEXT_CREDENTIAL_SECRET } = process.env;
if (!AGENT_DATA_DIR || !FRAME_CREDENTIAL_SECRET || !FRAME_NEXT_CREDENTIAL_SECRET) {
  throw new Error("请提供 AGENT_DATA_DIR、FRAME_CREDENTIAL_SECRET 与 FRAME_NEXT_CREDENTIAL_SECRET。");
}
if (FRAME_CREDENTIAL_SECRET === FRAME_NEXT_CREDENTIAL_SECRET) throw new Error("新旧凭据主密钥相同。");
const db = openAgentDatabase(AGENT_DATA_DIR);
try { rotateCredentialSecret(db, FRAME_CREDENTIAL_SECRET, FRAME_NEXT_CREDENTIAL_SECRET); }
finally { db.close(); }
console.log("凭据已重新加密。请以新主密钥启动服务。");
