import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import { authenticate, signOut } from "./lib/auth";
import { issueGameToken, launchGame, loadSlotBets, type GameSession, type SlotBet } from "./lib/game";
import { supabase } from "./lib/supabase";
import DepositFlow from "./DepositFlow";
import Wallet from "./Wallet";

type Mode = "signin" | "signup";
type NavTab = "cashier" | "games" | "bonuses" | "profile";
type GameFilter = "all" | "popular" | "cards" | "buffalo";

type Profile = {
  phone: string;
  balance: number;
  game_uid: string;
  created_at: string;
};

const BANNERS = [
  "https://9blqhfvaufeml8ge.public.blob.vercel-storage.com/banners/ChatGPT%20Image%20Jul%2029%2C%202026%2C%2008_27_15%20PM.webp",
  "https://9blqhfvaufeml8ge.public.blob.vercel-storage.com/banners/ChatGPT%20Image%20Jul%2029%2C%202026%2C%2009_08_27%20PM.webp",
  "/images/JL-banner.jpg",
];

const Ic = {
  cashier: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <rect x="1" y="4" width="22" height="16" rx="3" />
      <line x1="1" y1="10" x2="23" y2="10" />
    </svg>
  ),
  games: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M8.2 7.5h7.6a5 5 0 0 1 4.8 3.6l1.1 4a3.1 3.1 0 0 1-5.4 2.8l-1.2-1.5H8.9l-1.2 1.5a3.1 3.1 0 0 1-5.4-2.8l1.1-4a5 5 0 0 1 4.8-3.6z" />
    </svg>
  ),
  gift: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <polyline points="20 12 20 22 4 22 4 12" />
      <rect x="2" y="7" width="20" height="5" />
      <line x1="12" y1="22" x2="12" y2="7" />
    </svg>
  ),
  profile: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5.5 20a6.5 6.5 0 0 1 13 0" />
    </svg>
  ),
  close: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  ),
  headphones: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
      <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" />
    </svg>
  ),
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
  const [walletOpen, setWalletOpen] = useState(false);
  const [walletMode, setWalletMode] = useState<"deposit" | "withdraw">("deposit");
  const [navTab, setNavTab] = useState<NavTab>("games");
  const [gameFilter, setGameFilter] = useState<GameFilter>("popular");
  const [bannerIdx, setBannerIdx] = useState(0);
  const [bannerFailed, setBannerFailed] = useState<Record<number, boolean>>({});
  const [scrolled, setScrolled] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    const timer = window.setInterval(() => {
      setBannerIdx((current) => (current + 1) % BANNERS.length);
    }, 4200);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => setScrolled(el.scrollTop > 8);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [session, navTab]);

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
      setNavTab("games");
      setWalletOpen(false);
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

  function openWallet(nextMode: "deposit" | "withdraw" = "deposit") {
    setWalletMode(nextMode);
    setWalletOpen(true);
    setNavTab("cashier");
  }

  function handleNav(id: NavTab) {
    if (id === "cashier") {
      openWallet("deposit");
      return;
    }
    setWalletOpen(false);
    setNavTab(id);
    scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }

  if (!ready) {
    return (
      <div className="loading-screen">
        <div className="spinner" />
      </div>
    );
  }

  if (!session) {
    return (
      <main className="auth-page">
        <div className="auth-glow" />
        <div className="auth-box">
          <img className="auth-logo" src="/images/design-mode/log.png" alt="JL Win777" />
          <h1>{mode === "signin" ? "Welcome back" : "Create your account"}</h1>
          <p>{mode === "signin" ? "Sign in to continue playing" : "Sign up to start playing"}</p>
          <form className="auth-form" onSubmit={onSubmit}>
            <label>
              Phone number
              <input
                type="tel"
                name="phone"
                autoComplete="tel"
                inputMode="numeric"
                placeholder="09xxxxxxxxx"
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
                placeholder={mode === "signup" ? "At least 6 characters" : "••••••••"}
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
            <button className="gold-btn" type="submit" disabled={busy}>
              {busy ? "Please wait…" : mode === "signin" ? "Sign in" : "Sign up"}
            </button>
          </form>
          <p className="auth-switch">
            {mode === "signin" ? "Don't have an account? " : "Already have an account? "}
            <button
              type="button"
              onClick={() => {
                setMode(mode === "signin" ? "signup" : "signin");
                setError("");
              }}
            >
              {mode === "signin" ? "Sign up" : "Sign in"}
            </button>
          </p>
        </div>
      </main>
    );
  }

  const phoneNumber =
    profile?.phone ??
    session.user.phone ??
    (session.user.user_metadata?.phone as string | undefined) ??
    "—";
  const balance = profile?.balance ?? 0;
  const showBuffalo = gameFilter !== "cards";
  const sectionTitle =
    gameFilter === "all"
      ? "အားလုံးဂိမ်းများ"
      : gameFilter === "popular"
        ? "ရေပန်းစားသော ဂိမ်းများ"
        : gameFilter === "cards"
          ? "ကတ်ဂိမ်းများ"
          : "ကျွဲဂိမ်းများ";
  const bannerSrc = bannerFailed[bannerIdx] ? "/images/JL-banner.jpg" : BANNERS[bannerIdx];

  return (
    <div className="telegram-app-root">
      <div className="telegram-app-content">
        <div className="shell">
          <header className={`app-top-bar${scrolled ? " scrolled" : ""}`}>
            <img className="brand-logo" src="/images/exact-casino-logo.png" alt="JL Win777" />
            <div className="balance-chip">
              <div className="balance-value">
                <strong>{balance.toLocaleString("en-US")}</strong>
                <span>Ks</span>
              </div>
              <div className="balance-divider" />
              <button type="button" className="topup-chip" onClick={() => openWallet("deposit")}>
                <span>+</span>
                ငွေဖြည့်
              </button>
            </div>
            <button type="button" className="avatar-btn" onClick={() => handleNav("profile")} aria-label="အကောင့်">
              🎭
            </button>
          </header>

          <div className="body-scroll" ref={scrollRef}>
            {navTab === "profile" ? (
              <section className="profile-page">
                <div className="profile-kicker">အကောင့်</div>
                <h1>ကိုယ်ရေး</h1>
                <div className="profile-hero">
                  <div className="profile-row">
                    <div className="profile-mark">{Ic.profile}</div>
                    <div>
                      <div className="profile-name">{phoneNumber}</div>
                      <div className="profile-sub">UID {profile?.game_uid ?? "—"}</div>
                    </div>
                  </div>
                  <button type="button" className="profile-balance-btn" onClick={() => openWallet("deposit")}>
                    <span>
                      <small>လက်ကျန်ငွေ</small>
                      <strong>
                        {balance.toLocaleString("en-US")} <span>Ks</span>
                      </strong>
                    </span>
                  </button>
                </div>
                <div className="profile-list">
                  <button type="button" onClick={() => openWallet("deposit")}>
                    ↓ ငွေသွင်းမှတ်တမ်း
                  </button>
                  <button type="button" onClick={() => openWallet("withdraw")}>
                    ↑ ငွေထုတ်မှတ်တမ်း
                  </button>
                  <button type="button" onClick={onCreateGameSession} disabled={busy}>
                    {gameSession ? "Refresh token" : "Create game session"}
                  </button>
                </div>
                {gameSession ? (
                  <div className="mono-box">
                    uid: {gameSession.uid}
                    <br />
                    token: {gameSession.token}
                  </div>
                ) : null}
                {bets.length > 0 ? (
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
                ) : null}
                {error ? <p className="error" style={{ margin: "12px 16px 0" }}>{error}</p> : null}
                <button type="button" className="sign-out" onClick={onSignOut} disabled={busy}>
                  {busy ? "Signing out…" : "Sign out"}
                </button>
              </section>
            ) : navTab === "bonuses" ? (
              <div className="placeholder-panel">ဘောနပ်စ် မရှိသေးပါ</div>
            ) : (
              <>
                <div className="banner-wrap">
                  <div className="banner">
                    <img
                      src={bannerSrc}
                      alt=""
                      onError={() => setBannerFailed((current) => ({ ...current, [bannerIdx]: true }))}
                    />
                    <div className="banner-dots">
                      {BANNERS.map((_, index) => (
                        <button
                          key={index}
                          type="button"
                          className={index === bannerIdx ? "active" : ""}
                          onClick={() => setBannerIdx(index)}
                        />
                      ))}
                    </div>
                  </div>
                </div>

                <div className="chips">
                  {(
                    [
                      ["all", "အားလုံး"],
                      ["popular", "ရေပန်းစား"],
                      ["cards", "ကတ်ဂိမ်း"],
                      ["buffalo", "ကျွဲဂိမ်း"],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      className={`chip${gameFilter === id ? " active" : ""}`}
                      onClick={() => setGameFilter(id)}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                <div className="games-section">
                  <p className="games-title">{sectionTitle}</p>
                  {showBuffalo ? (
                    <div className="games-grid">
                      <button type="button" className="game-tile" onClick={onPlayBuffalo} disabled={playing}>
                        <div className="game-art">
                          <img src="/images/buffalo.png" alt="Buffalo" />
                        </div>
                      </button>
                    </div>
                  ) : (
                    <div className="games-empty">ဂိမ်းမရှိသေးပါ</div>
                  )}
                </div>

                <div className="fab-wrap">
                  <button type="button" className="fab" aria-label="Support">
                    {Ic.headphones}
                  </button>
                </div>
              </>
            )}
          </div>

          <nav className={`bottom-navigation${walletOpen ? " hidden" : ""}`}>
            {(
              [
                ["cashier", "ငွေ", Ic.cashier],
                ["games", "ဂိမ်း", Ic.games],
                ["bonuses", "ဘောနပ်စ်", Ic.gift],
                ["profile", "အကောင့်", Ic.profile],
              ] as const
            ).map(([id, label, icon]) => (
              <button
                key={id}
                type="button"
                data-id={id}
                className={`nav-item${navTab === id ? " active" : ""}`}
                onClick={() => handleNav(id)}
              >
                <span className="nav-icon">{icon}</span>
                <span className="nav-label">{label}</span>
              </button>
            ))}
          </nav>

          {walletOpen && walletMode === "deposit" ? (
            <DepositFlow
              onClose={() => {
                setWalletOpen(false);
                setNavTab("games");
              }}
              onBalance={(next) =>
                setProfile((current) => (current ? { ...current, balance: next } : current))
              }
            />
          ) : null}

          {walletOpen && walletMode === "withdraw" ? (
            <Wallet
              defaultPhone={phoneNumber === "—" ? "" : phoneNumber}
              onClose={() => {
                setWalletOpen(false);
                setNavTab("games");
              }}
              onBalance={(next) =>
                setProfile((current) => (current ? { ...current, balance: next } : current))
              }
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
