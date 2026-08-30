import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RoleAgentLoopCheckpoint } from "./role-agent-loop.js";

export function roleAgentCheckpointKey(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function fileRoleAgentLoopCheckpoint(filePath: string, key: string): RoleAgentLoopCheckpoint {
  return {
    key,
    async load(): Promise<unknown | undefined> {
      try {
        return JSON.parse(await readFile(filePath, "utf8")) as unknown;
      } catch (error) {
        if (hasCode(error, "ENOENT")) return undefined;
        throw error;
      }
    },
    async save(value: unknown): Promise<void> {
      await mkdir(path.dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        });
        await rename(temporaryPath, filePath);
      } finally {
        await rm(temporaryPath, { force: true });
      }
    },
  };
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: string }).code === code;
}
