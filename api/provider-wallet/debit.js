import { handleSkmWallet } from "../_skm-wallet.js";

export const config = { api: { bodyParser: false } };

export default function handler(req, res) {
  return handleSkmWallet(req, res, "debit");
}
