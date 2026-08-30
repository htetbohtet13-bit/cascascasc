import { paymentForwardHeaders } from "./payment-env.mjs";

export async function handleWalletProxy({
  authHeader,
  supabaseUrl,
  anonKey,
  functionName,
  method = "POST",
  payload = {},
}) {
  if (!authHeader) {
    return { status: 401, body: { error: "Not authenticated" } };
  }
  if (!supabaseUrl || !anonKey) {
    return { status: 500, body: { error: "Server is not configured" } };
  }

  const forwarded = await fetch(`${supabaseUrl}/functions/v1/${functionName}`, {
    method,
    headers: {
      Authorization: authHeader,
      apikey: anonKey,
      "Content-Type": "application/json",
      ...paymentForwardHeaders(),
    },
    body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(payload ?? {}),
  });

  const body = await forwarded.json().catch(() => ({}));
  return { status: forwarded.status, body };
}
