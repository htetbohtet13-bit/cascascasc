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

const methods: { id: PayMethod; name: string }[] = [
  { id: "kbzpay", name: "KBZPay" },
  { id: "wavepay", name: "WavePay" },
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
    <section className="card">
      <p className="eyebrow">Wallet</p>
      <h1>{mode === "deposit" ? "Deposit" : "Withdraw"}</h1>
      <div className="tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "deposit"}
          className={mode === "deposit" ? "active" : ""}
          onClick={() => resetFlow("deposit")}
        >
          Deposit
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "withdraw"}
          className={mode === "withdraw" ? "active" : ""}
          onClick={() => resetFlow("withdraw")}
        >
          Withdraw
        </button>
      </div>

      <p className="step-label">Step {Math.min(step, 3)} of 3</p>

      {step === 1 ? (
        <div className="method-grid">
          {methods.map((item) => (
            <button key={item.id} type="button" className="method-card" onClick={() => chooseMethod(item.id)}>
              {item.name}
            </button>
          ))}
        </div>
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
          <label>
            Amount
            <input
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              required
            />
          </label>
          {error ? <p className="error">{error}</p> : null}
          <button type="submit">Next</button>
          <button type="button" className="secondary" onClick={() => setStep(1)}>
            Back
          </button>
        </form>
      ) : null}

      {step === 3 && method ? (
        <form onSubmit={onSubmit}>
          {mode === "deposit" ? (
            <label>
              Last 6 digits
              <input
                type="text"
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                value={digits}
                onChange={(event) => setDigits(event.target.value.replace(/\D/g, "").slice(0, 6))}
                required
              />
            </label>
          ) : (
            <label>
              Receive phone
              <input
                type="tel"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                placeholder="09..."
                required
              />
            </label>
          )}
          {error ? <p className="error">{error}</p> : null}
          <button type="submit" disabled={busy}>
            {busy ? "Please wait…" : mode === "deposit" ? "Verify and add" : "Request withdraw"}
          </button>
          <button type="button" className="secondary" onClick={() => setStep(2)} disabled={busy}>
            Back
          </button>
        </form>
      ) : null}

      {step === 4 ? (
        <div>
          <p className="success">{done}</p>
          <button type="button" onClick={onClose}>
            Done
          </button>
        </div>
      ) : null}

      {step !== 4 ? (
        <button type="button" className="secondary" onClick={onClose} disabled={busy}>
          Close
        </button>
      ) : null}
    </section>
  );
}
