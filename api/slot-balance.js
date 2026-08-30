import { proxySlot } from "../_slot-proxy.js";

export default function handler(req, res) {
  return proxySlot(req, res, "/functions/v1/slot-balance");
}
