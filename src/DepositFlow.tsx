import { useEffect, useRef, useState } from "react";
import { loadWalletMethods, submitDeposit, type PayMethod, type WalletMethods } from "./lib/wallet";

type FlowStep = 1 | 2 | 3 | 4;
type SubmitStatus = "idle" | "verifying" | "success" | "failed";

type Props = {
  onClose: () => void;
  onBalance: (balance: number) => void;
};

const BANKS: { id: PayMethod; label: string; img: string; cls: string }[] = [
  { id: "kbzpay", label: "KBZPay", img: "/images/design-mode/kpay.png", cls: "kbz" },
  { id: "wavepay", label: "WavePay", img: "/images/design-mode/wavepay.png", cls: "wave" },
];

const QUICK_AMOUNTS = [5000, 10000, 20000, 50000, 100000, 500000];
const RECEIPT_INSTRUCTION = "/images/design-mode/receipt-instructions.jpg";
const NAME_FALLBACK = "Moe Nan Win";
const DIRECT_LINES = [
  "ငွေလွှဲစာရင်း ပြင်ဆင်နေသည်…",
  "ငွေပေးချေမှုသို့ ညွှန်းနေသည်…",
  "အသေးစိတ် ဖွင့်နေသည်…",
];

function formatTime(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${remaining.toString().padStart(2, "0")}`;
}

function IconArrow() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function IconShield() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 3l8 4v5c0 5-3.4 9.4-8 11-4.6-1.6-8-6-8-11V7l8-4z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

function IconClock() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function IconCopy() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function IconX() {
  return (
    <svg width="43" height="43" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

export default function DepositFlow({ onClose, onBalance }: Props) {
  const [step, setStep] = useState<FlowStep>(1);
  const [method, setMethod] = useState<PayMethod | null>(null);
  const [amount, setAmount] = useState("");
  const [receiptDigits, setReceiptDigits] = useState("");
  const [config, setConfig] = useState<WalletMethods | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [timeLeft, setTimeLeft] = useState(600);
  const [status, setStatus] = useState<SubmitStatus>("idle");
  const [statusMessage, setStatusMessage] = useState("");
  const [redirectCountdown, setRedirectCountdown] = useState(3);
  const [directing, setDirecting] = useState(false);
  const [directPhase, setDirectPhase] = useState(0);
  const [loadingMethods, setLoadingMethods] = useState(true);
  const receiptInputRef = useRef<HTMLInputElement>(null);
  const directingTimer = useRef<number | null>(null);

  const numericAmount = Number(amount || 0);
  const bank = BANKS.find((item) => item.id === method);
  const account = method && config ? config[method].receiver : "";
  const receiverName = (method && config?.[method].name?.trim()) || NAME_FALLBACK;

  useEffect(() => {
    let active = true;
    const fallback = window.setTimeout(() => {
      if (active) setLoadingMethods(false);
    }, 2500);
    loadWalletMethods()
      .then((data) => {
        if (active) setConfig(data);
      })
      .catch((err) => {
        if (active) setMessage(err instanceof Error ? err.message : "Could not load payment methods");
      })
      .finally(() => {
        if (active) setLoadingMethods(false);
      });
    return () => {
      active = false;
      window.clearTimeout(fallback);
    };
  }, []);

  useEffect(() => {
    if (step !== 3 || timeLeft <= 0) return;
    const timer = window.setInterval(() => setTimeLeft((current) => Math.max(0, current - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [step, timeLeft]);

  useEffect(() => {
    if (step !== 3 || directing) return;
    const timer = window.setTimeout(() => receiptInputRef.current?.focus(), 280);
    return () => window.clearTimeout(timer);
  }, [step, directing]);

  useEffect(() => {
    if ((status !== "success" && status !== "failed") || redirectCountdown <= 0) return;
    const timer = window.setTimeout(() => setRedirectCountdown((current) => current - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [status, redirectCountdown]);

  useEffect(() => {
    if ((status === "success" || status === "failed") && redirectCountdown === 0) onClose();
  }, [status, redirectCountdown, onClose]);

  useEffect(() => {
    return () => {
      if (directingTimer.current) window.clearTimeout(directingTimer.current);
    };
  }, []);

  function startDirecting() {
    if (directingTimer.current) window.clearTimeout(directingTimer.current);
    setDirecting(true);
    setDirectPhase(0);
    setTimeLeft(600);
    const t1 = window.setTimeout(() => setDirectPhase(1), 700);
    const t2 = window.setTimeout(() => setDirectPhase(2), 1400);
    directingTimer.current = window.setTimeout(() => {
      setDirecting(false);
      setStep(3);
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    }, 2200);
  }

  function chooseBank(next: PayMethod) {
    setMethod(next);
    setMessage(null);
    setStep(2);
  }

  function continueFromAmount() {
    if (numericAmount < 1000) {
      setMessage("အနည်းဆုံး 1,000 Ks ထည့်ပါ");
      return;
    }
    if (numericAmount > 50_000_000) {
      setMessage("ပမာဏ အရမ်းများနေပါသည်");
      return;
    }
    setMessage(null);
    startDirecting();
  }

  async function copyValue(value: string, key: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      window.setTimeout(() => setCopied(null), 1600);
    } catch {
      setMessage("ကူးယူမရပါ");
    }
  }

  async function confirmDeposit() {
    if (!method || numericAmount < 1000) {
      setStep(1);
      return;
    }
    if (!/^\d{6}$/.test(receiptDigits)) {
      setMessage("ပြေစာနောက်ဆုံး 6 လုံးထည့်ပါ");
      return;
    }
    setMessage(null);
    setStep(4);
    setStatus("verifying");
    setRedirectCountdown(3);
    try {
      const result = await submitDeposit(method, numericAmount, receiptDigits);
      onBalance(result.balance);
      setStatus("success");
      setStatusMessage(result.message || "လက်ကျန်ငွေ ထည့်ပြီးပါပြီ");
    } catch (err) {
      setStatus("failed");
      setStatusMessage(err instanceof Error ? err.message : "ငွေလွှဲမှု မတွေ့ရှိပါ");
    }
  }

  function goBack() {
    setMessage(null);
    if (directing || step === 4) return;
    if (step === 1) {
      onClose();
      return;
    }
    if (step === 3) {
      setStep(2);
      return;
    }
    setStep((step - 1) as FlowStep);
  }

  return (
    <main className="deposit-flow">
      <div className="deposit-glow" />
      {!directing && step !== 3 ? (
        <header className="deposit-header">
          <button type="button" className="deposit-icon-btn" onClick={goBack} disabled={step === 4} aria-label="နောက်သို့">
            <IconArrow />
          </button>
          <div className="deposit-header-title">
            <div>ငွေသွင်း</div>
            <span>လုံခြုံသော ငွေပေးချေမှု</span>
          </div>
          <div className="deposit-shield">
            <IconShield />
          </div>
        </header>
      ) : null}

      <div
        className={`deposit-scroll${step === 3 && !directing ? " pay-page" : ""}${directing ? " is-directing" : ""}`}
      >
        {directing ? (
          <section className="deposit-directing">
            <div className="deposit-directing-glow" />
            <div className="deposit-spinner-wrap">
              <div className="deposit-spinner" />
            </div>
            <h1>ငွေပေးချေမှုသို့ ညွှန်းနေသည်</h1>
            <p>{DIRECT_LINES[directPhase]}</p>
            {method && bank ? (
              <div className="deposit-panel deposit-directing-bank">
                <img src={bank.img} alt="" />
                <div>
                  <strong>{bank.label}</strong>
                  <em>{numericAmount.toLocaleString("en-US")} Ks</em>
                </div>
              </div>
            ) : null}
            <div className="deposit-progress">
              <div style={{ width: `${((directPhase + 1) / DIRECT_LINES.length) * 100}%` }} />
            </div>
          </section>
        ) : null}

        {step === 1 && !directing ? (
          <section className="deposit-section">
            <h1>ဘဏ်ရွေးပါ</h1>
            <p className="deposit-sub">သင်အသုံးပြုမည့် ဘဏ်ကိုရွေးပါ</p>
            {loadingMethods ? (
              <div className="deposit-panel deposit-loading">
                <div className="deposit-spinner" />
              </div>
            ) : (
              <div className="deposit-bank-grid">
                {BANKS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`deposit-bank-card ${item.cls}`}
                    onClick={() => chooseBank(item.id)}
                  >
                    <img src={item.img} alt="" />
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>
            )}
            {message ? <p className="deposit-error">{message}</p> : null}
            <div className="deposit-secure">🔒 သင့်ငွေပေးချေမှုကို လုံခြုံစွာ စစ်ဆေးပေးပါမည်</div>
          </section>
        ) : null}

        {step === 2 && method && bank && !directing ? (
          <section className="deposit-section">
            <div className="deposit-panel deposit-chosen">
              <img src={bank.img} alt="" />
              <div>
                <strong>{bank.label}</strong>
                <em>ရွေးထားသောဘဏ်</em>
              </div>
              <button type="button" onClick={() => setStep(1)}>
                ပြောင်းမည်
              </button>
            </div>
            <h1>ပမာဏထည့်ပါ</h1>
            <p className="deposit-sub">အနည်းဆုံး 1,000 Ks</p>
            <div className="deposit-panel deposit-amount-card">
              <div className="deposit-label">ငွေပမာဏ</div>
              <div className="deposit-amount-box">
                <input
                  value={amount}
                  onChange={(event) => {
                    setAmount(event.target.value.replace(/\D/g, "").slice(0, 8));
                    setMessage(null);
                  }}
                  inputMode="numeric"
                  autoFocus
                  placeholder="0"
                  aria-label="ငွေပမာဏ"
                />
                <span>Ks</span>
              </div>
              <div className="deposit-quick">
                {QUICK_AMOUNTS.map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={numericAmount === value ? "active" : ""}
                    onClick={() => {
                      setAmount(String(value));
                      setMessage(null);
                    }}
                  >
                    {value.toLocaleString("en-US")}
                  </button>
                ))}
              </div>
              {numericAmount >= 5000 ? (
                <div className="deposit-bonus">🎁 ကြိုဆိုဘောနပ်စ်အတွက် အရည်အချင်းပြည့်မီသည်</div>
              ) : null}
            </div>
            {message ? <p className="deposit-error">{message}</p> : null}
            <button type="button" className="deposit-primary" onClick={continueFromAmount}>
              ရှေ့ဆက်မည်
            </button>
          </section>
        ) : null}

        {step === 3 && method && bank && !directing ? (
          <section className="deposit-pay-white">
            <div className="deposit-pay-white-bar">
              <button type="button" onClick={goBack}>
                <IconArrow />
                နောက်သို့
              </button>
            </div>
            <div className="deposit-white-card">
              <div className="deposit-white-head">
                <div>
                  <img src={bank.img} alt="" />
                  <strong>{bank.label === "KBZPay" ? "KBZ Pay" : "Wave Pay"}</strong>
                </div>
                <div className="deposit-white-timer">
                  <IconClock />
                  {formatTime(timeLeft)}
                </div>
              </div>

              {[
                { key: "receiver", label: "နာမည်", value: receiverName, copy: receiverName },
                { key: "account", label: "ငွေလွှဲရန် နံပါတ်", value: account, copy: account },
                {
                  key: "amount",
                  label: "လွှဲရန် ပမာဏ",
                  value: `${numericAmount.toLocaleString("en-US")}ကျပ်`,
                  copy: String(numericAmount),
                },
              ].map((row) => (
                <div key={row.key} className="deposit-white-row">
                  <div>
                    <em>{row.label}</em>
                    <strong>{row.value || "—"}</strong>
                  </div>
                  <button
                    type="button"
                    aria-label={`${row.label} ကူးယူရန်`}
                    className={copied === row.key ? "copied" : ""}
                    onClick={() => {
                      if (!row.copy) return;
                      void copyValue(row.copy, row.key);
                    }}
                    disabled={!row.copy}
                  >
                    {copied === row.key ? <IconCheck /> : <IconCopy />}
                  </button>
                </div>
              ))}

              <p className="deposit-white-hint">ငွေလွှဲပြီးပါက လုပ်ငန်းစဉ် နောက်ဆုံးနံပါတ်6လုံးထည့်ပါ👇</p>

              <div className={`deposit-white-otp${receiptDigits.length === 6 ? " done" : ""}`}>
                <input
                  ref={receiptInputRef}
                  value={receiptDigits}
                  onChange={(event) => {
                    setReceiptDigits(event.target.value.replace(/\D/g, "").slice(0, 6));
                    setMessage(null);
                  }}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  placeholder="000000"
                  aria-label="ပြေစာနောက်ဆုံး 6 လုံး"
                />
              </div>

              <div className="deposit-white-instruction">
                <img src={RECEIPT_INSTRUCTION} alt="နောက်ဆုံး ၆ လုံး ရှာရန်" />
              </div>

              {message ? <p className="deposit-white-error">{message}</p> : null}

              <button
                type="button"
                className="deposit-white-confirm"
                onClick={() => void confirmDeposit()}
                disabled={receiptDigits.length !== 6 || timeLeft === 0}
              >
                အတည်ပြုမည်
              </button>
            </div>
          </section>
        ) : null}

        {step === 4 && !directing ? (
          <section className="deposit-panel deposit-result">
            {status === "verifying" ? (
              <>
                <div className="deposit-result-icon spin">
                  <div className="deposit-spinner" />
                </div>
                <h1>စစ်ဆေးနေသည်</h1>
                <p>
                  ငွေလွှဲမှုကို လုံခြုံစွာ
                  <br />
                  စစ်ဆေးနေပါသည်
                </p>
              </>
            ) : null}
            {status === "success" ? (
              <>
                <div className="deposit-result-icon ok">
                  <IconCheck />
                </div>
                <h1>ငွေသွင်းအောင်မြင်</h1>
                <div className="deposit-result-amount">
                  {numericAmount.toLocaleString("en-US")} <span>Ks</span>
                </div>
                <p>{statusMessage}</p>
                {numericAmount >= 5000 ? (
                  <div className="deposit-bonus result-bonus">🎁 ဘောနပ်စ်ရှိပါက အလိုအလျောက် ထည့်ပေးပါမည်</div>
                ) : null}
              </>
            ) : null}
            {status === "failed" ? (
              <>
                <div className="deposit-result-icon bad">
                  <IconX />
                </div>
                <h1>စစ်ဆေးမရပါ</h1>
                <p className="bad-msg">{statusMessage}</p>
                <p className="tiny">ပြေစာနံပါတ်ကို ပြန်စစ်ပါ</p>
              </>
            ) : null}
            {status === "success" || status === "failed" ? (
              <>
                <div className="deposit-progress result">
                  <div
                    className={status === "success" ? "ok" : "bad"}
                    style={{ width: `${((3 - redirectCountdown) / 3) * 100}%` }}
                  />
                </div>
                <p className="tiny">{redirectCountdown} စက္ကန့်အတွင်း ဂိမ်းသို့ပြန်မည်</p>
                <button type="button" className="deposit-primary" onClick={onClose}>
                  ဂိမ်းသို့ပြန်မည်
                </button>
              </>
            ) : null}
          </section>
        ) : null}
      </div>
    </main>
  );
}
