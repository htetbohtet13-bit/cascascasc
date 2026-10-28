import { handleAdminApi } from "../../server/admin-api.mjs";
import { unsafeRequestError } from "../../server/request-security.mjs";
import { readJsonBody, sendBodyError } from "../../server/request-body.mjs";

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  const requestError = unsafeRequestError(req);
  if (requestError) return res.status(requestError.status).json(requestError.body);
  try {
    let adminRequest = req;
    if (req.method === "POST") {
      // Framework body properties may be read-only lazy getters. Keep the
      // validated payload separate without invoking or assigning that getter.
      adminRequest = Object.create(req);
      Object.defineProperty(adminRequest, "body", { value: await readJsonBody(req) });
    }
    const result = await handleAdminApi(adminRequest);
    for (const [name, value] of Object.entries(result.headers ?? {})) res.setHeader(name, value);
    return res.status(result.status).json(result.body);
  } catch (error) {
    if (sendBodyError(res, error)) return;
    console.error("Admin request failed", { code: error?.code ?? "unavailable" });
    return res.status(503).json({ error: "Administration is temporarily unavailable. Please try again later." });
  }
}
