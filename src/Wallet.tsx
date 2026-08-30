import { useEffect, useState, type FormEvent } from "react";
import {
  loadWalletMethods,
  submitDeposit,
  submitWithdraw,
  type PayMethod,
  type WalletMethods,
} from "./lib/wallet";

type Mode = "deposit" | "withdraw";

type Props = {
  initialMode?: Mode;
  defaultPhone?: string;
  onClose: () => void;
  onBalance: (balance: number) => void;
};

const methods: { id: PayMethod; name: string; img: string; cls: string }[] = [
  { id: "kbzpay", name: "KBZPay", img: "/images/design-mode/kpay.png", cls: "kbz" },
  { id: "wavepay", name: "WavePay", img: "/images/design-mode/wavepay.png", cls: "wave" },
];

export default function Wallet({
  initialMode = "deposit",
  defaultPhone = "",
  onClose,
  onBalance,
}: Props) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [step, setStep] = useState(1);
  const [method, setMethod] = useState<PayMethod | null>(null);
  const [amount, setAmount] = useState("");
  const [digits, setDigits] = useState("");
  const [phone, setPhone] = useState(defaultPhone.replace(/^\+95/, "0"));
  const [config, setConfig] = useState<WalletMethods | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  useEffect(() => {
    loadWalletMethods()
      .then(setConfig)
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load payment methods"));
  }, []);

  const receiver = method && config ? config[method].receiver : "";
  const quickAmounts = mode === "deposit" ? ["5000", "10000", "20000"] : ["1000", "2000", "4000"];

  function resetFlow(nextMode: Mode) {
    setMode(nextMode);
    setStep(1);
    setMethod(null);
    setAmount("");
    setDigits("");
    setError("");
    setDone("");
  }

  function chooseMethod(next: PayMethod) {
    setMethod(next);
    setError("");
    setDone("");
    setStep(2);
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!method) return;
    setError("");
    setBusy(true);
    try {
      if (mode === "deposit") {
        const result = await submitDeposit(method, Number(amount), digits);
        onBalance(result.balance);
        setDone(result.message);
      } else {
        const result = await submitWithdraw(method, Number(amount), phone);
        onBalance(result.balance);
        setDone(result.message);
      }
      setStep(4);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not complete the request");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="wallet-sheet">
      <div className="wallet-head">
        <h2>ပိုက်ဆံအိတ်</h2>
        <button type="button" className="icon-btn" onClick={onClose} disabled={busy} aria-label="Close">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div className="wallet-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "deposit"}
          className={mode === "deposit" ? "active" : ""}
          onClick={() => resetFlow("deposit")}
        >
          ငွေသွင်း
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "withdraw"}
          className={mode === "withdraw" ? "active" : ""}
          onClick={() => resetFlow("withdraw")}
        >
          ငွေထုတ်
        </button>
      </div>

      <div className="wallet-body">
        {step === 1 ? (
          <>
            <p className="wallet-title">ဘဏ်ရွေးပါ</p>
            <p className="wallet-sub">သင်အသုံးပြုမည့် ဘဏ်ကိုရွေးပါ</p>
            <div className="bank-grid">
              {methods.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`bank-card ${item.cls}`}
                  onClick={() => chooseMethod(item.id)}
                >
                  <img src={item.img} alt="" />
                  {item.name}
                </button>
              ))}
            </div>
            {error ? <p className="error">{error}</p> : null}
          </>
        ) : null}

        {step === 2 && method ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!amount || Number(amount) <= 0) {
                setError("Enter an amount");
                return;
              }
              setError("");
              setStep(3);
            }}
          >
            {mode === "deposit" && receiver ? (
              <p className="pay-to">
                Pay this number with {method === "kbzpay" ? "KBZPay" : "WavePay"}:
                <strong> {receiver}</strong>
                <button
                  type="button"
                  className="linkish"
                  onClick={() => navigator.clipboard.writeText(receiver)}
                >
                  Copy
                </button>
              </p>
            ) : null}
            <label className="field">
              ပမာဏ
              <div className="field-box">
                <input
                  type="text"
                  inputMode="numeric"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value.replace(/\D/g, ""))}
                  placeholder="0"
                  required
                />
                <span>Ks</span>
              </div>
            </label>
            <div className="quick-row">
              {quickAmounts.map((value) => (
                <button key={value} type="button" onClick={() => setAmount(value)}>
                  {Number(value).toLocaleString("en-US")}
                </button>
              ))}
            </div>
            {error ? <p className="error">{error}</p> : null}
            <button className="primary-btn" type="submit">
              Next
            </button>
            <button type="button" className="ghost-btn" onClick={() => setStep(1)}>
              Back
            </button>
          </form>
        ) : null}

        {step === 3 && method ? (
          <form onSubmit={onSubmit}>
            {mode === "deposit" ? (
              <label className="field">
                Last 6 digits
                <div className="field-box">
                  <input
                    type="text"
                    inputMode="numeric"
                    pattern="\d{6}"
                    maxLength={6}
                    value={digits}
                    onChange={(event) => setDigits(event.target.value.replace(/\D/g, "").slice(0, 6))}
                    required
                  />
                </div>
              </label>
            ) : (
              <label className="field">
                Your {method === "kbzpay" ? "KBZPay" : "WavePay"} number
                <div className="field-box">
                  <input
                    type="tel"
                    value={phone}
                    onChange={(event) => setPhone(event.target.value)}
                    placeholder="09..."
                    required
                  />
                </div>
              </label>
            )}
            {error ? <p className="error">{error}</p> : null}
            <button className="primary-btn" type="submit" disabled={busy}>
              {busy
                ? mode === "withdraw"
                  ? "Sending… this can take up to 90 seconds"
                  : "Please wait…"
                : mode === "deposit"
                  ? "Verify and add"
                  : "ငွေထုတ်မည်"}
            </button>
            <button type="button" className="ghost-btn" onClick={() => setStep(2)} disabled={busy}>
              Back
            </button>
          </form>
        ) : null}

        {step === 4 ? (
          <div>
            <p className="success">{done}</p>
            <button type="button" className="primary-btn" onClick={onClose}>
              Done
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
