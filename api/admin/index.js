import { handleAdminApi } from "../../server/admin-api.mjs";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  const result = await handleAdminApi(req);
  for (const [name, value] of Object.entries(result.headers ?? {})) res.setHeader(name, value);
  return res.status(result.status).json(result.body);
}
