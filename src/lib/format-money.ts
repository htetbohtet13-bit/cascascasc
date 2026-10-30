// Presentation only. Preserve exact Postgres numeric strings rather than
// rounding a large or fractional report amount through JavaScript Number.
export function formatMoney(value: number | string | null | undefined, signed = false) {
  if (value == null) return "—";
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value));
  if (!match) return "—";
  const whole = BigInt(match[2]);
  const fraction = (match[3] ?? "").replace(/0+$/, "");
  const nonzero = whole !== 0n || fraction.length > 0;
  const sign = nonzero && match[1] ? "−" : nonzero && signed ? "+" : "";
  return `${sign}${whole.toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
}
