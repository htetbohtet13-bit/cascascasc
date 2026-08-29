import { useEffect, useState, type FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import { authenticate, signOut } from "./lib/auth";
import { issueGameToken, launchGame, loadSlotBets, type GameSession, type SlotBet } from "./lib/game";
import { supabase } from "./lib/supabase";
import "./App.css";

type Mode = "signin" | "signup";

type Profile = {
  phone: string;
  balance: number;
  game_uid: string;
  created_at: string;
};

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [bets, setBets] = useState<SlotBet[]>([]);
  const [gameSession, setGameSession] = useState<GameSession | null>(null);
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<Mode>("signin");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });

    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
    });

    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) {
      setProfile(null);
      setBets([]);
      setGameSession(null);
      return;
    }

    supabase
      .from("profiles")
      .select("phone, balance, game_uid, created_at")
      .eq("id", session.user.id)
      .maybeSingle()
      .then(({ data }) => {
        setProfile(data);
      });

    loadSlotBets(session.user.id)
      .then(setBets)
      .catch(() => setBets([]));
  }, [session]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");

    if (mode === "signup" && password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    setBusy(true);
    try {
      await authenticate(mode, phone, password);
      setPassword("");
      setConfirmPassword("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  async function onSignOut() {
    setBusy(true);
    setError("");
    try {
      await signOut();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign out");
    } finally {
      setBusy(false);
    }
  }

  async function onPlayBuffalo() {
    setPlaying(true);
    setError("");
    try {
      const url = await launchGame(23, 1);
      window.location.assign(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open the game");
      setPlaying(false);
    }
  }

  async function onCreateGameSession() {
    setBusy(true);
    setError("");
    try {
      const next = await issueGameToken();
      setGameSession(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create game session");
    } finally {
      setBusy(false);
    }
  }

  if (!ready) {
    return (
      <main className="page">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  if (session) {
    const phoneNumber =
      profile?.phone ??
      session.user.phone ??
      (session.user.user_metadata?.phone as string | undefined) ??
      "—";
    const balance = profile?.balance ?? 0;

    return (
      <main className="page">
        <section className="card">
          <p className="eyebrow">Signed in</p>
          <h1>Welcome</h1>
          <p className="balance">{balance.toLocaleString()} pts</p>
          <dl className="details">
            <div>
              <dt>Phone</dt>
              <dd>{phoneNumber}</dd>
            </div>
            <div>
              <dt>UID</dt>
              <dd className="mono">{profile?.game_uid ?? "—"}</dd>
            </div>
          </dl>

          <div className="games">
            <p className="section-label">Games</p>
            <article className="game-card">
              <div>
                <p className="eyebrow">Slot</p>
                <h2>Buffalo</h2>
                <p className="muted">Game 23 · Room 1</p>
              </div>
              <button type="button" onClick={onPlayBuffalo} disabled={playing || busy}>
                {playing ? "Opening…" : "Play"}
              </button>
            </article>
          </div>

          <div className="session">
            <p className="section-label">Game session</p>
            <p className="muted">
              Create a token, then the game vendor can call balance and change-balance
              with this uid and token.
            </p>
            {gameSession ? (
              <dl className="session-box">
                <div>
                  <dt>uid</dt>
                  <dd>{gameSession.uid}</dd>
                </div>
                <div>
                  <dt>token</dt>
                  <dd>{gameSession.token}</dd>
                </div>
              </dl>
            ) : null}
            <button type="button" className="secondary" onClick={onCreateGameSession} disabled={busy}>
              {busy ? "Please wait…" : gameSession ? "Refresh token" : "Create game session"}
            </button>
          </div>

          {bets.length > 0 ? (
            <div className="bets-wrap">
              <p className="section-label">Recent bets</p>
              <table className="bets">
                <thead>
                  <tr>
                    <th>Bet</th>
                    <th>Win</th>
                    <th>Change</th>
                    <th>Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {bets.map((bet) => (
                    <tr key={bet.bet_uid}>
                      <td>{bet.bet}</td>
                      <td>{bet.win}</td>
                      <td>{bet.changemoney}</td>
                      <td>{bet.balance_after}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {error ? <p className="error">{error}</p> : null}
          <button type="button" onClick={onSignOut} disabled={busy}>
            {busy ? "Signing out…" : "Sign out"}
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="page">
      <section className="card">
        <p className="eyebrow">Account</p>
        <h1>{mode === "signin" ? "Sign in" : "Create account"}</h1>
        <p className="muted">Use your phone number and a password.</p>

        <div className="tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "signin"}
            className={mode === "signin" ? "active" : ""}
            onClick={() => {
              setMode("signin");
              setError("");
            }}
          >
            Sign in
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "signup"}
            className={mode === "signup" ? "active" : ""}
            onClick={() => {
              setMode("signup");
              setError("");
            }}
          >
            Sign up
          </button>
        </div>

        <form onSubmit={onSubmit}>
          <label>
            Phone number
            <input
              type="tel"
              name="phone"
              autoComplete="tel"
              placeholder="09 123 456 789"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              required
            />
          </label>
          <label>
            Password
            <input
              type="password"
              name="password"
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
              minLength={6}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          {mode === "signup" ? (
            <label>
              Confirm password
              <input
                type="password"
                name="confirmPassword"
                autoComplete="new-password"
                minLength={6}
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                required
              />
            </label>
          ) : null}
          {error ? <p className="error">{error}</p> : null}
          <button type="submit" disabled={busy}>
            {busy
              ? "Please wait…"
              : mode === "signin"
                ? "Sign in"
                : "Create account"}
          </button>
        </form>
      </section>
    </main>
  );
}
