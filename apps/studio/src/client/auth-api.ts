const AUTHENTICATION_LOST_EVENT = "video-factory:authentication-lost";
export type StudioAuthSession =
  | { enabled: false; authenticated: true }
  | { enabled: true; authenticated: false }
  | { enabled: true; authenticated: true; username: string };

export function subscribeToAuthenticationLoss(listener: () => void): () => void {
  globalThis.addEventListener?.(AUTHENTICATION_LOST_EVENT, listener);
  return () => globalThis.removeEventListener?.(AUTHENTICATION_LOST_EVENT, listener);
}
export function notifyAuthenticationLoss(url: string, status: number): void {
  if (status !== 401 || url === "/api/auth/login") return;
  globalThis.dispatchEvent?.(new Event(AUTHENTICATION_LOST_EVENT));
}
async function authRequest<T>(url: string, body?: object): Promise<T> {
  const response = await fetch(url, { method: body ? "POST" : "GET", ...(body ? {
    headers: { "content-type": "application/json", "x-video-factory-request": "studio" }, body: JSON.stringify(body),
  } : {}) });
  notifyAuthenticationLoss(url, response.status);
  const text = await response.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!response.ok) throw new Error(data?.error ?? "登录请求失败，请重试。");
  return data as T;
}
export const authApi = {
  authSession: () => authRequest<StudioAuthSession>("/api/auth/session"),
  login: (username: string, password: string) => authRequest<StudioAuthSession>("/api/auth/login", { username, password }),
  logout: () => authRequest<void>("/api/auth/logout", {}),
};
