export function normalizePhone(input) {
  const digits = String(input ?? "").trim().replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return null;

  if (digits.startsWith("09") && digits.length >= 10 && digits.length <= 12) {
    return `+95${digits.slice(1)}`;
  }
  if (digits.startsWith("959") && digits.length >= 11) return `+${digits}`;
  return `+${digits}`;
}

export function phoneUsername(phone) {
  return String(phone ?? "").replace(/\D/g, "");
}

export function phoneLoginEmail(phone) {
  return `${phoneUsername(phone)}@phone.local`;
}
