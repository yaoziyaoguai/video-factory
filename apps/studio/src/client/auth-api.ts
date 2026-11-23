const AUTHENTICATION_LOST_EVENT = "video-factory:authentication-lost";
export type StudioAuthSession =
  | { enabled: false; authenticated: true }
  | { enabled: true; authenticated: false }
  | { enabled: true; authenticated: true; username: string; ownerId: string };

export function subscribeToAuthenticationLoss(listener: () => void): () => void {
  globalThis.addEventListener?.(AUTHENTICATION_LOST_EVENT, listener);
  return () => globalThis.removeEventListener?.(AUTHENTICATION_LOST_EVENT, listener);
}
export function notifyAuthenticationLoss(url: string, status: number): void {
  if (status !== 401 || url === "/api/auth/login") return;
  globalThis.dispatchEvent?.(new Event(AUTHENTICATION_LOST_EVENT));
}
export class AuthRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
async function authRequest<T>(url: string, body?: object): Promise<T> {
  const response = await fetch(url, { method: body ? "POST" : "GET", ...(body ? {
    headers: { "content-type": "application/json", "x-video-factory-request": "studio" }, body: JSON.stringify(body),
  } : {}) });
  notifyAuthenticationLoss(url, response.status);
  const text = await response.text();
  if (!response.ok) {
    const type = response.headers.get("content-type")?.split(";", 1)[0];
    const message = type === "application/json" && text ? JSON.parse(text).error : type === "text/plain" ? text.trim() : undefined;
    throw new AuthRequestError(response.status, typeof message === "string" && message ? message : `登录服务返回 ${response.status}，请稍后重试。`);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}
export const authApi = {
  authSession: () => authRequest<StudioAuthSession>("/api/auth/session"),
  login: (username: string, password: string) => authRequest<StudioAuthSession>("/api/auth/login", { username, password }),
  logout: () => authRequest<void>("/api/auth/logout", {}),
};
