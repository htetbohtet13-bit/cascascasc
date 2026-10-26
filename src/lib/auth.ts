type AuthAction = "signup" | "signin";

async function authRequest<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/auth/${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "include",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Request failed");
  return payload as T;
}

export async function authenticate(action: AuthAction, phone: string, password: string) {
  await authRequest(action === "signup" ? "sign-up" : "sign-in", { phone, password });
}

export function getSession() {
  return authRequest<{ user?: { id: string; name?: string; username?: string } } | null>("get-session");
}

export async function signOut() {
  await authRequest("sign-out", {});
}
