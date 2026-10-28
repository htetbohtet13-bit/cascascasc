import { AuthError, currentSession, signInPhone, signOut, signUpPhone } from "../../server/auth.mjs";
import { normalizePhone } from "../../server/phone.mjs";
import { unsafeRequestError } from "../../server/request-security.mjs";
import { consumeRateLimit } from "../../server/rate-limit.mjs";
import { readJsonBody, sendBodyError } from "../../server/request-body.mjs";

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  const requestError = unsafeRequestError(req);
  if (requestError) return res.status(requestError.status).json(requestError.body);
  const route = new URL(req.url ?? "/", "http://localhost").pathname.split("/").filter(Boolean).at(-1);
  try {
    if (route === "get-session" && req.method === "GET") {
      const session = await currentSession(req);
      return res.status(200).json(session);
    }
    if (route === "sign-out" && req.method === "POST") {
      await readJsonBody(req);
      res.setHeader("Set-Cookie", await signOut(req));
      return res.status(200).json({ success: true });
    }
    if ((route === "sign-up" || route === "signup") && req.method === "POST") {
      const body = await readJsonBody(req);
      const phone = typeof body.phone === "string" && body.phone.length <= 64 ? body.phone : "";
      const limited = await consumeRateLimit(req, "sign-up", normalizePhone(phone) ?? "invalid");
      if (limited) {
        for (const [name, value] of Object.entries(limited.headers ?? {})) res.setHeader(name, value);
        return res.status(limited.status).json(limited.body);
      }
      const result = await signUpPhone(phone, body.password);
      res.setHeader("Set-Cookie", result.cookie);
      return res.status(200).json({ user: result.user });
    }
    if ((route === "sign-in" || route === "signin") && req.method === "POST") {
      const body = await readJsonBody(req);
      const phone = typeof body.phone === "string" && body.phone.length <= 64 ? body.phone : "";
      const limited = await consumeRateLimit(req, "sign-in", normalizePhone(phone) ?? "invalid");
      if (limited) {
        for (const [name, value] of Object.entries(limited.headers ?? {})) res.setHeader(name, value);
        return res.status(limited.status).json(limited.body);
      }
      const result = await signInPhone(phone, body.password);
      res.setHeader("Set-Cookie", result.cookie);
      return res.status(200).json({ user: result.user });
    }
    return res.status(404).json({ error: "Not found" });
  } catch (error) {
    if (sendBodyError(res, error)) return;
    if (error instanceof AuthError) return res.status(error.status).json({ error: error.message });
    console.error("Authentication request failed", { code: error?.code ?? "unavailable" });
    return res.status(503).json({ error: "Could not complete authentication. Please try again later." });
  }
}
