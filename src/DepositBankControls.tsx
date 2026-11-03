import { useEffect, useRef, useState } from "react";

type Bank = "kbzpay" | "wavepay";
type Banks = Record<Bank, { enabled: boolean }>;
const BANKS: { id: Bank; label: string; image: string }[] = [
  { id: "kbzpay", label: "KBZPay", image: "/images/design-mode/kpay.png" },
  { id: "wavepay", label: "WavePay", image: "/images/design-mode/wavepay.png" },
];

function checkedBanks(value: unknown): Banks {
  const banks = value as Banks | null;
  if (!banks || typeof banks.kbzpay?.enabled !== "boolean" || typeof banks.wavepay?.enabled !== "boolean") {
    throw new Error("Could not confirm bank availability. Refresh to check again.");
  }
  return banks;
}

export default function DepositBankControls() {
  const [banks, setBanks] = useState<Banks | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const sending = useRef(false);
  const version = useRef(0);

  async function request(bank?: Bank) {
    if (sending.current) return;
    sending.current = true;
    const current = ++version.current;
    setBusy(bank ?? "load");
    setError("");
    try {
      const response = await fetch(bank ? "/api/admin" : "/api/admin?view=deposit_banks", {
        credentials: "include",
        ...(bank ? { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "set_deposit_bank", service_type: bank, enabled: !banks![bank].enabled }) } : {}),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not update bank availability. Refresh to check again.");
      const confirmed = checkedBanks(result.banks);
      if (current === version.current) setBanks(confirmed);
    } catch (reason) {
      if (current === version.current) {
        // A lost reply may follow a successful save. Read back before permitting
        // another toggle instead of presenting an unconfirmed state as current.
        setBanks(null);
        setError(reason instanceof Error ? reason.message : "Could not confirm bank availability. Refresh to check again.");
      }
    } finally {
      if (current === version.current) { sending.current = false; setBusy(""); }
    }
  }

  useEffect(() => { void request(); return () => { version.current++; sending.current = false; }; }, []);

  return (
    <section className="admin-deposit-banks" aria-label="Top-up banks" aria-busy={busy !== ""}>
      <div className="admin-bank-heading"><h2>Top-up banks</h2><button type="button" onClick={() => void request()} disabled={busy !== ""}>Refresh</button></div>
      <div className="admin-bank-grid">
        {BANKS.map((bank) => (
          <div className="admin-bank-row" key={bank.id}>
            <img src={bank.image} alt="" /><strong>{bank.label}</strong>
            <button type="button" role="switch" aria-label={`${bank.label} top-ups`} aria-checked={banks?.[bank.id].enabled ?? false}
              className={`admin-bank-switch ${banks ? banks[bank.id].enabled ? "on" : "off" : "unknown"}`}
              disabled={!banks || busy !== ""} onClick={() => void request(bank.id)}>
              <span aria-hidden="true" />{busy === bank.id ? "Saving…" : banks ? banks[bank.id].enabled ? "On" : "Off" : "—"}
            </button>
          </div>
        ))}
      </div>
      <p>Changes apply to top-ups only.</p>
      {error ? <div className="admin-error" role="alert">{error}</div> : null}
    </section>
  );
}
