import { handleAdminApi } from "../../server/admin-api.mjs";

export default async function handler(req, res) {
  const result = await handleAdminApi(req);
  return res.status(result.status).json(result.body);
}
