import { currentSession, signInPhone, signOut, signUpPhone } from "../../server/auth.mjs";

function bodyOf(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return {};
}

export default async function handler(req, res) {
  const route = new URL(req.url ?? "/", "http://localhost").pathname.split("/").filter(Boolean).at(-1);
  try {
    if (route === "get-session" && req.method === "GET") {
      const session = await currentSession(req);
      return res.status(200).json(session);
    }
    if (route === "sign-out" && req.method === "POST") {
      res.setHeader("Set-Cookie", await signOut(req));
      return res.status(200).json({ success: true });
    }
    if ((route === "sign-up" || route === "signup") && req.method === "POST") {
      const body = bodyOf(req);
      const result = await signUpPhone(body.phone, body.password);
      res.setHeader("Set-Cookie", result.cookie);
      return res.status(200).json({ user: result.user });
    }
    if ((route === "sign-in" || route === "signin") && req.method === "POST") {
      const body = bodyOf(req);
      const result = await signInPhone(body.phone, body.password);
      res.setHeader("Set-Cookie", result.cookie);
      return res.status(200).json({ user: result.user });
    }
    return res.status(404).json({ error: "Not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not complete request";
    const status = error?.code === "23505"
      ? 409
      : error?.code
        ? 500
        : /already registered/i.test(message)
          ? 409
          : /valid phone|at least 6|password/i.test(message)
            ? 400
            : 401;
    return res.status(status).json({ error: message });
  }
}
