import type { ConnectionModel, ProviderConnection } from "./generated/contracts.js";

export type NativeTextApi = "openai-responses" | "openai-completions" | "anthropic-messages";
type Adapter = { supportedKinds: readonly ConnectionModel["kind"][]; textApi: NativeTextApi | null; accountDirectory: boolean };

export const providerAdapters: Record<ProviderConnection["protocol"], Adapter> = {
  openai: { supportedKinds: ["text", "image", "speech"], textApi: "openai-responses", accountDirectory: true },
  "openai-chat-completions": { supportedKinds: ["text"], textApi: "openai-completions", accountDirectory: true },
  "anthropic-messages": { supportedKinds: ["text"], textApi: "anthropic-messages", accountDirectory: true },
  ark: { supportedKinds: ["text", "image", "video"], textApi: "openai-completions", accountDirectory: true },
  minimax: { supportedKinds: ["text", "video", "speech"], textApi: "openai-completions", accountDirectory: false },
  wan: { supportedKinds: ["video"], textApi: null, accountDirectory: false },
  colab: { supportedKinds: ["video"], textApi: null, accountDirectory: false },
};

export function textBaseUrl(protocol: ProviderConnection["protocol"], baseUrl: string): string {
  return protocol === "minimax" ? baseUrl + "/v1" : baseUrl;
}
