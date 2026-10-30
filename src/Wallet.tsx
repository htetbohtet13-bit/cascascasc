import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { loadWalletMethods, submitWithdraw, WalletRequestError, type PayMethod } from "./lib/wallet";
import PaymentResult from "./PaymentResult";

type Props = {
  embedded?: boolean;
  balance?: number;
  defaultPhone?: string;
  onClose: () => void;
  onBalance: (balance: number) => void;
  onFullscreenChange?: (fullscreen: boolean) => void;
  onHistory?: () => void;
};

const methods: { id: PayMethod; name: string; img: string; cls: string }[] = [
  { id: "kbzpay", name: "KBZPay", img: "/images/design-mode/kpay.png", cls: "kbz" },
  { id: "wavepay", name: "WavePay", img: "/images/design-mode/wavepay.png", cls: "wave" },
];

const quickAmounts = ["1000", "2000", "4000"];

function localPhone(value: string) {
  const digits = value.replace(/\D/g, "");
  return digits.startsWith("959") ? `0${digits.slice(2)}` : digits;
}

export default function Wallet({
  embedded = false,
  balance = 0,
  defaultPhone = "",
  onClose,
  onBalance,
  onFullscreenChange,
  onHistory,
}: Props) {
  const [step, setStep] = useState(1);
  const [method, setMethod] = useState<PayMethod | null>(null);
  const [amount, setAmount] = useState("");
  const [phone, setPhone] = useState(() => localPhone(defaultPhone));
  // Display-only: never include this name in requests or persistent storage.
  const [accountName, setAccountName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [wageringError, setWageringError] = useState("");
  const [done, setDone] = useState("");
  const [doneState, setDoneState] = useState<"paid" | "pending" | "failed">("paid");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const submitting = useRef(false);
  const bank = methods.find((item) => item.id === method);
  const numericAmount = Number(amount);

  useLayoutEffect(() => {
    onFullscreenChange?.(busy || step === 4);
  }, [busy, step, onFullscreenChange]);

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

  function validateAmount() {
    if (!method) {
      setError("KBZPay သို့မဟုတ် WavePay ကို ရွေးပါ။");
      return false;
    }
    if (!Number.isSafeInteger(numericAmount) || numericAmount <= 0) {
      setError("ငွေပမာဏကို မှန်ကန်စွာ ထည့်ပါ။");
      return false;
    }
    if (numericAmount > 1_000_000) {
      setError("တစ်ကြိမ်လျှင် အများဆုံး 1,000,000 ကျပ် ထုတ်နိုင်ပါသည်။");
      return false;
    }
    if (numericAmount > balance) {
      setError("လက်ကျန်ငွေ မလုံလောက်ပါ။");
      return false;
    }
    return true;
  }

  function validateAccount() {
    if (!accountName.trim()) {
      setError("အကောင့်အမည် ထည့်ပါ။");
      return false;
    }
    if (!/^09\d{8,10}$/.test(phone)) {
      setError("09 ဖြင့်စသော ဖုန်းနံပါတ်ကို မှန်ကန်စွာ ထည့်ပါ။");
      return false;
    }
    return true;
  }

  function goToStep(next: number) {
    if (submitting.current) return;
    setError("");
    setStep(next);
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (step !== 3 || submitting.current || !validateAmount() || !validateAccount() || !method) return;
    submitting.current = true;
    setError("");
    setBusy(true);
    try {
      const result = await submitWithdraw(method, numericAmount, phone, requestId);
      if (typeof result.balance === "number") onBalance(result.balance);
      setDone(result.message);
      setDoneState(result.state);
      if (result.state === "failed") setRequestId(crypto.randomUUID());
      setStep(4);
    } catch (err) {
      if (err instanceof WalletRequestError && err.code === "WAGERING_REQUIRED") {
        setWageringError(err.message);
        setStep(5);
      } else if (err instanceof WalletRequestError) {
        setError(err.message);
      } else {
        setDoneState("pending");
        setDone("ငွေထုတ်မှုရလဒ်ကို အတည်မပြုနိုင်သေးပါ။ ထပ်မံငွေမထုတ်ဘဲ မှတ်တမ်းကို စစ်ဆေးပါ။");
        setStep(4);
      }
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <section className={`wallet-sheet withdraw-flow${embedded ? " wallet-embedded" : ""}`}>
      {!embedded && !busy && step !== 4 ? <div className="wallet-head">
        <h2>ငွေထုတ်</h2>
        <button type="button" className="icon-btn" onClick={onClose} disabled={busy} aria-label="ပိတ်မည်">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div> : null}

      <div className="wallet-body">
        {step === 1 ? (
          <>
            <div className="avail-card">
              <small>လက်ရှိလက်ကျန်</small>
              <strong>{balance.toLocaleString("en-US")} <span>ကျပ်</span></strong>
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
                  <span>{item.name}</span>
                  {method === item.id ? <span className="withdraw-bank-check" aria-hidden="true">✓</span> : null}
                </button>
              ))}
            </div>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (validateAmount()) goToStep(2);
              }}
            >
              <label className="field">
                ငွေပမာဏ
                <div className="field-box">
                  <input
                    type="text"
                    inputMode="numeric"
                    id="withdraw-amount"
                    value={amount}
                    onChange={(event) => {
                      setAmount(event.target.value.replace(/\D/g, "").slice(0, 8));
                      setError("");
                    }}
                    placeholder="0"
                    required
                  />
                  <span>ကျပ်</span>
                </div>
              </label>
              <div className="quick-row">
                {quickAmounts.map((value) => (
                  <button key={value} type="button" onClick={() => { setAmount(value); setError(""); }}>
                    {Number(value).toLocaleString("en-US")}
                  </button>
                ))}
              </div>
              {error ? <p className="error withdraw-error" role="alert">{error}</p> : null}
              <button className="primary-btn withdraw-next" type="submit">
                ရှေ့ဆက်မည်
              </button>
            </form>
          </>
        ) : null}

        {step === 2 && bank ? (
          <>
            <div className="withdraw-selected-bank">
              <img src={bank.img} alt="" />
              <strong>{bank.name}</strong>
              <button type="button" onClick={() => goToStep(1)}>ပြောင်းမည်</button>
            </div>
            <h2 className="withdraw-step-title">ငွေလက်ခံမည့်အကောင့်</h2>
            <form onSubmit={(event) => {
              event.preventDefault();
              if (validateAccount()) goToStep(3);
            }}>
              <div className="withdraw-account-panel">
                <label className="field" htmlFor="withdraw-name">
                  အကောင့်အမည်
                  <div className="field-box">
                    <input id="withdraw-name" type="text" value={accountName} onChange={(event) => { setAccountName(event.target.value); setError(""); }} placeholder="အမည်ထည့်ပါ" autoComplete="off" maxLength={80} required />
                  </div>
                </label>
                <label className="field" htmlFor="withdraw-phone">
                  ဖုန်းနံပါတ်
                  <div className="field-box">
                    <input id="withdraw-phone" type="tel" inputMode="tel" value={phone} onChange={(event) => { setPhone(localPhone(event.target.value)); setError(""); }} placeholder="09xxxxxxxxx" autoComplete="tel-national" minLength={10} maxLength={16} pattern="09[0-9]{8,10}" required />
                  </div>
                </label>
              </div>
              {error ? <p className="error withdraw-error" role="alert">{error}</p> : null}
              <button className="primary-btn withdraw-next" type="submit">ရှေ့ဆက်မည်</button>
            </form>
          </>
        ) : null}

        {step === 3 && bank && !busy ? (
          <form onSubmit={(event) => void onSubmit(event)}>
            <h2 className="withdraw-step-title">ငွေထုတ်မှု အတည်ပြုရန်</h2>
            <section className="withdraw-preview" aria-label="ငွေထုတ်မည့် အချက်အလက်များ">
              <div className="withdraw-preview-bank">
                <img src={bank.img} alt="" />
                <strong>{bank.name}</strong>
              </div>
              <dl>
                <div><dt>အကောင့်အမည်</dt><dd>{accountName.trim()}</dd></div>
                <div><dt>ဖုန်းနံပါတ်</dt><dd>{phone}</dd></div>
                <div><dt>ငွေထုတ်ပမာဏ</dt><dd>{numericAmount.toLocaleString("en-US")} ကျပ်</dd></div>
              </dl>
            </section>
            {error ? <p className="error withdraw-error" role="alert">{error}</p> : null}
            <div className="withdraw-actions">
              <button className="withdraw-edit" type="button" onClick={() => goToStep(2)} disabled={busy}>ပြင်မည်</button>
              <button className="primary-btn" type="submit" disabled={busy}>{busy ? "လုပ်ဆောင်နေသည်…" : "အတည်ပြုပြီး ငွေထုတ်မည်"}</button>
            </div>
          </form>
        ) : null}

        {busy || step === 4 ? (
          <PaymentResult kind="withdraw" state={busy ? "processing" : doneState === "paid" ? "success" : doneState}
            amount={numericAmount} bank={bank ? { name: bank.name, image: bank.img } : undefined} phone={phone}
            message={busy ? "တောင်းဆိုမှုကို လုပ်ဆောင်နေပါသည်။" : doneState === "paid" ? "သင့်ဘဏ်အကောင့်သို့ ငွေလွှဲပေးပြီးပါပြီ။" : done}
            onClose={onClose} onHistory={onHistory}
            onRetry={!busy && doneState === "failed" ? () => { setDone(""); setError(""); setStep(1); } : undefined} />
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
