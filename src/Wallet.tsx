import { useEffect, useState, type FormEvent } from "react";
import { loadWalletMethods, submitWithdraw, WalletRequestError, type PayMethod } from "./lib/wallet";

type Props = {
  embedded?: boolean;
  balance?: number;
  defaultPhone?: string;
  onClose: () => void;
  onBalance: (balance: number) => void;
};

const methods: { id: PayMethod; name: string; img: string; cls: string }[] = [
  { id: "kbzpay", name: "KBZPay", img: "/images/design-mode/kpay.png", cls: "kbz" },
  { id: "wavepay", name: "WavePay", img: "/images/design-mode/wavepay.png", cls: "wave" },
];

const quickAmounts = ["1000", "2000", "4000"];

export default function Wallet({
  embedded = false,
  balance = 0,
  defaultPhone = "",
  onClose,
  onBalance,
}: Props) {
  const [step, setStep] = useState(1);
  const [method, setMethod] = useState<PayMethod | null>(null);
  const [amount, setAmount] = useState("");
  const [phone, setPhone] = useState(defaultPhone.replace(/^\+95/, "0"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [wageringError, setWageringError] = useState("");
  const [done, setDone] = useState("");
  const [doneState, setDoneState] = useState<"paid" | "pending" | "failed">("paid");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());

  useEffect(() => {
    loadWalletMethods().catch(() =>
      setError("ငွေပေးချေမှုနည်းလမ်းများကို ဖွင့်မရပါ။ ခဏစောင့်ပြီး ပြန်လည်ကြိုးစားပါ။"),
    );
  }, []);

  function chooseMethod(next: PayMethod) {
    setMethod(next);
    setError("");
    setDone("");
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!method) return;
    setError("");
    setBusy(true);
    try {
      const result = await submitWithdraw(method, Number(amount), phone, requestId);
      if (typeof result.balance === "number") onBalance(result.balance);
      setDone(result.message);
      setDoneState(result.state);
      if (result.state === "failed") setRequestId(crypto.randomUUID());
      setStep(4);
    } catch (err) {
      if (err instanceof WalletRequestError && err.code === "WAGERING_REQUIRED") {
        setWageringError(err.message);
        setStep(5);
      } else {
        setError(err instanceof WalletRequestError ? err.message : "ငွေထုတ်ခြင်း မအောင်မြင်ပါ။ ပြန်လည်ကြိုးစားပါ။");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
      <section className={`wallet-sheet${embedded ? " wallet-embedded" : ""}`}>
      {!embedded ? <div className="wallet-head">
        <h2>ငွေထုတ်</h2>
        <button type="button" className="icon-btn" onClick={onClose} disabled={busy} aria-label="ပိတ်မည်">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div> : null}

      <div className="wallet-body">
        {step !== 4 && step !== 5 ? (
          <>
            <div className="avail-card">
              <small>လက်ရှိလက်ကျန်</small>
              <strong>{balance.toLocaleString("my-MM")} <span>ကျပ်</span></strong>
            </div>
            <p className="wallet-title">ငွေလက်ခံမည့်ဘဏ်</p>
            <div className="bank-grid">
              {methods.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`bank-card ${item.cls}${method === item.id ? " selected" : ""}`}
                  onClick={() => chooseMethod(item.id)}
                  aria-pressed={method === item.id}
                >
                  <img src={item.img} alt="" />
                  {item.name}
                </button>
              ))}
            </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!method) {
                setError("KBZPay သို့မဟုတ် WavePay ကို ရွေးပါ");
                return;
              }
              if (!amount || Number(amount) <= 0) {
                setError("ငွေပမာဏ ထည့်ပါ");
                return;
              }
              if (!phone.trim()) {
                setError("ဖုန်းနံပါတ် ထည့်ပါ");
                return;
              }
              void onSubmit(event);
            }}
          >
            <label className="field">
              ငွေပမာဏ
              <div className="field-box">
                <input
                  type="text"
                  inputMode="numeric"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value.replace(/\D/g, ""))}
                  placeholder="0"
                  required
                />
                <span>ကျပ်</span>
              </div>
            </label>
            <div className="quick-row">
              {quickAmounts.map((value) => (
                <button key={value} type="button" onClick={() => setAmount(value)}>
                  {Number(value).toLocaleString("my-MM")}
                </button>
              ))}
            </div>
            <label className="field">
              {method ? `${method === "kbzpay" ? "KBZPay" : "WavePay"} ဖုန်းနံပါတ်` : "ဖုန်းနံပါတ်"}
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
            {error ? <p className="error">{error}</p> : null}
            <button className="primary-btn" type="submit" disabled={busy}>
              {busy ? "လုပ်ဆောင်နေသည်…" : "ငွေထုတ်မည်"}
            </button>
          </form>
          </>
        ) : null}

        {step === 4 ? (
          <div>
            <p className={doneState === "pending" ? "wallet-pending" : doneState === "failed" ? "error" : "success"}>
              {done}
            </p>
            {doneState === "failed" ? (
              <button
                type="button"
                className="primary-btn"
                onClick={() => {
                  setDone("");
                  setError("");
                  setStep(1);
                }}
              >
                ပြန်လည်ကြိုးစားမည်
              </button>
            ) : (
              <button type="button" className="primary-btn" onClick={onClose}>
                ပြီးပါပြီ
              </button>
            )}
          </div>
        ) : null}

        {step === 5 ? (
          <div className="withdraw-wagering-error" role="alert">
            <span className="withdraw-wagering-mark" aria-hidden="true">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <circle cx="12" cy="12" r="9" /><path d="M12 7v6m0 4h.01" />
              </svg>
            </span>
            <h3>ငွေထုတ်၍ မရသေးပါ</h3>
            <p>{wageringError}</p>
            <button type="button" className="primary-btn" onClick={onClose}>ဂိမ်းဆက်ကစားမည်</button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
