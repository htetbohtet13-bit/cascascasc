import { Fragment, useEffect, useRef, useState, type FormEvent } from "react";
import { formatMoney } from "./lib/format-money";

type Section = "overview" | "users" | "games" | "bets" | "deposits" | "withdrawals";
type OverviewRange = "today" | "yesterday" | "week" | "month" | "all";
const OVERVIEW_RANGES: { id: OverviewRange; label: string; title: string }[] = [
  { id: "today", label: "Today", title: "Today summary" },
  { id: "yesterday", label: "Yesterday", title: "Yesterday summary" },
  { id: "week", label: "This week", title: "This week summary" },
  { id: "month", label: "This month", title: "This month summary" },
  { id: "all", label: "All", title: "All-time summary" },
];
type UserRow = { id: string; phone: string; balance: number | string; created_at: string };
type BetRow = {
  bet_uid: string; round_id: string | null; bet: number | string; win: number | string | null;
  changemoney?: number | string | null; balance_after?: number | string; game_id?: number | null;
  game_code?: string | null; activity_type?: "bet" | "banker"; status?: "settled" | "pending" | "cancelled";
  held_amount?: number | string; transaction_id?: string; source?: "skm" | "legacy"; settled_at?: string | null;
  created_at: string; user_id: string; phone: string;
};
type WalletRow = {
  order_id: string; user_id: string; phone: string; service_type: string;
  amount: number | string; status: string; message: string | null; created_at: string;
  bonus_amount?: number | string;
  completed_at: string | null; provider_txn_id?: string | null; payout_phone?: string | null; reference?: string | null;
};
type Summary = Record<string, number | string>;
type ProviderPool = {
  pool_id: string; name: string; currency: string;
  limits?: { min_bet?: number; max_bet?: number };
};
type ProviderTable = { table_id: string; name: string; currency: string };
type ProviderGame = {
  game_code: string; name: string; pools?: ProviderPool[]; tables?: ProviderTable[];
  image_url?: string | null; players_online?: number | null; sort_order?: number; is_active?: boolean; is_hot?: boolean;
};
type Payload = {
  summary?: Summary; latestBets?: BetRow[]; latestWithdrawals?: WalletRow[];
  users?: UserRow[]; games?: ProviderGame[]; bets?: BetRow[]; deposits?: WalletRow[]; withdrawals?: WalletRow[];
  user?: UserRow; total?: number; page?: number; pageSize?: number; settingsConfigured?: boolean;
};
type UserDetail = Payload & { user: UserRow; bets: BetRow[]; deposits: WalletRow[]; withdrawals: WalletRow[];
  bonus?: { order_id: string; amount: string | number; bonus_amount: string | number; wagering_required: string; completed_at: string } | null };

const SECTIONS: { id: Section; label: string; mark: string }[] = [
  { id: "overview", label: "Overview", mark: "▦" },
  { id: "users", label: "Players", mark: "♙" },
  { id: "games", label: "Provider games", mark: "▣" },
  { id: "bets", label: "Bet history", mark: "♧" },
  { id: "deposits", label: "Deposits", mark: "＋" },
  { id: "withdrawals", label: "Withdrawals", mark: "↓" },
];

function money(value: number | string | null | undefined) {
  return `${formatMoney(value ?? 0)} Ks`;
}

function date(value: string | null | undefined) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Rangoon" });
}

function Status({ value }: { value: string }) {
  return <span className={`admin-status ${value}`}>{value}</span>;
}

function TableEmpty({ loading }: { loading: boolean }) {
  return <div className="admin-empty">{loading ? "Loading records…" : "No records found."}</div>;
}

export default function AdminDashboard() {
  const [section, setSection] = useState<Section>("overview");
  const [selectedUserId, setSelectedUserId] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [refreshKey, setRefreshKey] = useState(0);
  const [overviewRange, setOverviewRange] = useState<OverviewRange>("today");
  const [data, setData] = useState<Payload | UserDetail>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [authCode, setAuthCode] = useState(0);
  const [sessionVerified, setSessionVerified] = useState(false);
  const [loginPassword, setLoginPassword] = useState("");
  const [loginCode, setLoginCode] = useState("");
  const [mfaRequired, setMfaRequired] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const requestVersion = useRef(0);

  useEffect(() => {
    let active = true;
    const version = ++requestVersion.current;
    const isCurrent = () => active && version === requestVersion.current;
    const timer = window.setTimeout(() => {
      const view = selectedUserId ? "user" : section;
      const params = new URLSearchParams({ view });
      if (selectedUserId) params.set("user_id", selectedUserId);
      if (section === "overview" && !selectedUserId) params.set("range", overviewRange);
      if (section !== "overview" && !selectedUserId) {
        params.set("page", String(page));
        if (search.trim()) params.set("search", search.trim());
        if ((section === "deposits" || section === "withdrawals") && status) params.set("status", status);
      }
      setLoading(true);
      setError("");
      fetch(`/api/admin?${params.toString()}`, { credentials: "include" })
        .then(async (response) => {
          const payload = await response.json();
          if (!response.ok) {
            const failure = new Error(payload.error || "Could not load dashboard data") as Error & { status?: number; mfaRequired?: boolean };
            failure.status = response.status;
            failure.mfaRequired = payload.mfaRequired === true;
            throw failure;
          }
          if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Could not verify admin access");
          return payload;
        })
        .then((payload) => {
          if (!isCurrent()) return;
          setData(payload);
          setSessionVerified(true);
          setAuthCode(0);
        })
        .catch((reason: Error & { status?: number; mfaRequired?: boolean }) => {
          if (!isCurrent()) return;
          setSessionVerified(false);
          setData({});
          setError(reason.message || "Could not load dashboard data");
          setAuthCode(reason.status || 0);
          if (reason.status === 401) {
            setMfaRequired(reason.mfaRequired === true);
          }
        })
        .finally(() => {
          if (isCurrent()) setLoading(false);
        });
    }, 220);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [section, selectedUserId, search, status, page, refreshKey, overviewRange]);

  function changeSection(next: Section) {
    setSection(next);
    setSelectedUserId("");
    setPage(1);
    setStatus("");
    setSearch("");
  }

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    requestVersion.current += 1;
    setLoginError("");
    setLoginBusy(true);
    try {
      const response = await fetch("/api/admin", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "login", password: loginPassword, code: loginCode }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 401) setMfaRequired(result.mfaRequired === true);
        throw new Error(result.error || "ဝင်ရောက်၍ မရပါ။ ထပ်မံကြိုးစားပါ။");
      }
      setLoginPassword("");
      setLoginCode("");
      setSessionVerified(false);
      setLoading(true);
      setAuthCode(0);
      setError("");
      setRefreshKey((value) => value + 1);
    } catch (reason) {
      setLoginError(reason instanceof Error ? reason.message : "Could not sign in");
      setLoginCode("");
    } finally {
      setLoginBusy(false);
    }
  }

  async function logout() {
    // An earlier dashboard response must not restore access after sign-out.
    requestVersion.current += 1;
    setLoading(false);
    setError("");
    try {
      const response = await fetch("/api/admin", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "logout" }),
      });
      if (!response.ok) throw new Error("Could not sign out");
      setData({});
      setLoginPassword("");
      setLoginCode("");
      setSessionVerified(false);
      setAuthCode(401);
    } catch {
      setError("Could not confirm sign-out. Please try again.");
    }
  }

  const total = data.total ?? 0;
  const pageSize = data.pageSize ?? 50;
  const canGoBack = page > 1;
  const canGoNext = page * pageSize < total;
  const detail = selectedUserId ? data as UserDetail : null;

  if (authCode === 401 || authCode === 503) {
    return (
      <main className="admin-gate" aria-labelledby="admin-login-title">
        <div className="admin-gate-card">
          <h1 id="admin-login-title">{authCode === 401 ? "စီမံခန့်ခွဲသူ ဝင်ရန်" : "ယာယီ အသုံးမပြုနိုင်ပါ"}</h1>
          {authCode === 401 ? (
            <>
              <form className="admin-login-form" onSubmit={(event) => void login(event)}>
                <label htmlFor="admin-secret">စီမံခန့်ခွဲသူ စကားဝှက်</label>
                <input id="admin-secret" type="password" value={loginPassword} onChange={(event) => setLoginPassword(event.target.value)} autoComplete="current-password" autoFocus disabled={loginBusy} required />
                {mfaRequired ? (
                  <>
                    <label htmlFor="admin-otp">Authenticator ကုဒ် (၆ လုံး)</label>
                    <input id="admin-otp" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" minLength={6} maxLength={6} placeholder="000000" value={loginCode} onChange={(event) => setLoginCode(event.target.value.replace(/[^0-9]/g, "").slice(0, 6))} disabled={loginBusy} required />
                  </>
                ) : null}
                {loginError ? <span role="alert">{loginError}</span> : null}
                <button className="admin-gate-button" type="submit" disabled={loginBusy}>{loginBusy ? "စစ်ဆေးနေပါသည်…" : "ဝင်မည်"}</button>
              </form>
            </>
          ) : (
            <>
              <p>{error}</p>
            </>
          )}
        </div>
      </main>
    );
  }

  // Never mount the dashboard until a protected data request has succeeded.
  // Login success alone is not enough: wait for the new session to be checked.
  if (!sessionVerified) {
    return (
      <main className="admin-gate" aria-busy={loading}>
        <div className="admin-gate-card">
          {loading ? <p role="status">စစ်ဆေးနေပါသည်…</p> : (
            <>
              <p role="alert">ယာယီ အသုံးမပြုနိုင်ပါ</p>
              <button className="admin-gate-button" type="button" onClick={() => {
                setLoading(true);
                setError("");
                setRefreshKey((value) => value + 1);
              }}>ပြန်ကြိုးစားမည်</button>
            </>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className="admin-shell">
      <aside className="admin-sidebar">
        <a className="admin-brand" href="/" aria-label="Back to casino home">
          <span className="admin-brand-mark">777</span>
          <span><strong>JL WIN777</strong><small>CONTROL ROOM</small></span>
        </a>
        <div className="admin-side-label">MANAGEMENT</div>
        <nav className="admin-side-nav" aria-label="Admin sections">
          {SECTIONS.map((item) => (
            <button key={item.id} type="button" className={section === item.id && !selectedUserId ? "active" : ""} onClick={() => changeSection(item.id)}>
              <span className="admin-nav-mark">{item.mark}</span>{item.label}
            </button>
          ))}
        </nav>
        <a className="admin-back-home" href="/">← Back to site</a>
      </aside>

      <section className="admin-workspace">
        <header className="admin-topbar">
          <div>
            <div className="admin-eyebrow">JL WIN777 / ADMIN</div>
            <h1>{selectedUserId ? "Player details" : SECTIONS.find((item) => item.id === section)?.label}</h1>
          </div>
          <button className="admin-refresh" type="button" onClick={() => setRefreshKey((value) => value + 1)} disabled={loading}>
            <span aria-hidden="true">↻</span> Refresh
          </button>
          <button className="admin-logout" type="button" onClick={() => void logout()}>Lock</button>
        </header>

        {error ? <div className="admin-error" role="alert">{error}</div> : null}
        {selectedUserId && detail?.user ? (
          <div className="admin-page-content">
            <button className="admin-back-link" type="button" onClick={() => setSelectedUserId("")}>← Back to players</button>
            <section className="admin-user-hero">
              <div className="admin-user-avatar">{detail.user.phone.slice(-2)}</div>
              <div><span>PLAYER ACCOUNT</span><h2>{detail.user.phone}</h2><p>Player ID: {detail.user.id}</p></div>
              <div className="admin-user-balance"><small>Wallet balance</small><strong>{money(detail.user.balance)}</strong></div>
            </section>
            <div className="admin-detail-grid">
              <div className="admin-detail-card"><small>Provider player ID</small><strong>{detail.user.id}</strong></div>
              <div className="admin-detail-card"><small>Joined</small><strong>{date(detail.user.created_at)}</strong></div>
              <div className="admin-detail-card"><small>Total bets shown</small><strong>{detail.bets?.length ?? 0}</strong></div>
              {detail.bonus ? <div className="admin-detail-card"><small>Welcome bonus awarded · {date(detail.bonus.completed_at)}</small><strong>{money(detail.bonus.bonus_amount)}</strong><p>Deposit: {money(detail.bonus.amount)} · Initial wagering: {money(detail.bonus.wagering_required)}</p><small>Order: {detail.bonus.order_id}</small></div> : null}
            </div>
            <div className="admin-detail-sections">
              <DetailBets bets={detail.bets ?? []} />
              <DetailWallet title="Deposits" rows={detail.deposits ?? []} />
              <DetailWallet title="Withdrawals" rows={detail.withdrawals ?? []} />
            </div>
          </div>
        ) : section === "overview" ? (
          <Overview data={data} loading={loading} onOpen={changeSection} range={overviewRange} onRangeChange={(next) => { if (next === overviewRange) return; requestVersion.current += 1; setLoading(true); setOverviewRange(next); }} />
        ) : section === "games" ? (
          <div className="admin-page-content"><ProviderGames games={(data as Payload).games ?? []} loading={loading} settingsConfigured={(data as Payload).settingsConfigured !== false} onSaved={() => setRefreshKey((value) => value + 1)} /></div>
        ) : (
          <div className="admin-page-content">
            <div className="admin-list-toolbar">
              <label className="admin-search"><span aria-hidden="true">⌕</span><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder={section === "users" ? "Search phone or player ID" : "Search player, round, or reference"} /></label>
              {(section === "deposits" || section === "withdrawals") ? (
                <select className="admin-filter" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }} aria-label="Filter by status">
                  <option value="">All statuses</option>
                  {(section === "deposits" ? ["verified", "pending", "failed"] : ["pending", "paid", "failed"]).map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              ) : null}
              <span className="admin-record-count">{total.toLocaleString()} records</span>
            </div>
            {section === "users" ? <UsersTable users={(data as Payload).users ?? []} loading={loading} onSelect={setSelectedUserId} /> : null}
            {section === "bets" ? <BetsTable bets={(data as Payload).bets ?? []} loading={loading} onSelect={setSelectedUserId} /> : null}
            {section === "deposits" ? <WalletTable rows={(data as Payload).deposits ?? []} loading={loading} onSelect={setSelectedUserId} kind="deposit" /> : null}
            {section === "withdrawals" ? <WalletTable rows={(data as Payload).withdrawals ?? []} loading={loading} onSelect={setSelectedUserId} kind="withdrawal" /> : null}
            <div className="admin-pagination"><span>Page {page} of {Math.max(1, Math.ceil(total / pageSize))}</span><div><button type="button" disabled={!canGoBack || loading} onClick={() => setPage((value) => value - 1)}>Previous</button><button type="button" disabled={!canGoNext || loading} onClick={() => setPage((value) => value + 1)}>Next</button></div></div>
          </div>
        )}
      </section>
    </main>
  );
}

function Overview({ data, loading, onOpen, range, onRangeChange }: { data: Payload; loading: boolean; onOpen: (section: Section) => void; range: OverviewRange; onRangeChange: (range: OverviewRange) => void }) {
  const summary = data.summary ?? {};
  const rangeTitle = OVERVIEW_RANGES.find((item) => item.id === range)?.title;
  const cards = [
    ["Total players", summary.users, "Live total", "All accounts", "users"],
    ["Current player balance", money(summary.total_balance), "Live total", "All wallets", "users"],
    ["Settled bet volume", money(summary.bet_total), "Reported wins", money(summary.win_total), "bets"],
    ["Pending withdrawals", summary.pending_withdrawals, "Failed in range", summary.failed_withdrawals, "withdrawals"],
    ["Game catalog", summary.active_games, "Total games", summary.games_total, "games"],
    ["Welcome bonuses", money(summary.bonus_total), "Awards in range", summary.bonus_count, "deposits"],
  ] as const;
  return (
    <div className="admin-page-content">
      <div className="admin-range-row" role="group" aria-label="Overview time range">
        {OVERVIEW_RANGES.map((item) => <button key={item.id} type="button" aria-pressed={range === item.id} className={range === item.id ? "active" : ""} onClick={() => onRangeChange(item.id)}>{item.label}</button>)}
      </div>
      <section className="admin-period-summary" aria-label={rangeTitle} aria-busy={loading}>
        <header><h2>{rangeTitle}</h2><span>Myanmar time</span></header>
        <div className="admin-period-metrics">
          <div><span>Deposits</span><strong className="positive">{loading ? "—" : money(summary.deposit_total)}</strong></div>
          <div><span>Withdrawals</span><strong className="outgoing">{loading ? "—" : money(summary.withdrawal_total)}</strong></div>
          <div title="Verified deposits minus paid withdrawals"><span>Net cash flow</span><strong className={Number(summary.net_cash_flow ?? 0) >= 0 ? "positive" : "outgoing"}>{loading ? "—" : `${Number(summary.net_cash_flow ?? 0) >= 0 ? "+" : ""}${money(summary.net_cash_flow)}`}</strong></div>
          <div><span>New users</span><strong className="new-users">{loading ? "—" : Number(summary.new_users ?? 0).toLocaleString("en-US")}</strong></div>
        </div>
      </section>
      <div className="admin-stat-grid">
        {cards.map(([label, value, note, sub, target]) => (
          <button key={label} className="admin-stat-card" type="button" onClick={() => onOpen(target as Section)}>
            <span>{label}</span><strong>{loading ? "—" : typeof value === "number" || typeof value === "string" ? value : "0"}</strong><small>{note}: {sub || "—"}</small>
          </button>
        ))}
        <button className="admin-stat-card" type="button" onClick={() => onOpen("bets")}><span>Bet records</span><strong>{loading ? "—" : Number(summary.bet_count ?? 0).toLocaleString()}</strong><small>Pending: {Number(summary.pending_bet_count ?? 0).toLocaleString()} · Cancelled: {Number(summary.cancelled_bet_count ?? 0).toLocaleString()}</small></button>
        {Number(summary.banker_count ?? 0) > 0 ? <button className="admin-stat-card" type="button" onClick={() => onOpen("bets")}><span>Banker net result</span><strong>{loading ? "—" : money(summary.banker_result)}</strong><small>Bank returns minus reserved funds</small></button> : null}
      </div>
      <p className="admin-report-note">Bet volume and wins include settled bets only, by settlement time in Myanmar. Banker activity is separate.</p>
      <div className="admin-overview-columns">
        <section className="admin-panel"><div className="admin-panel-heading"><div><span>LATEST ACTIVITY</span><h3>Recent game activity</h3></div><button type="button" onClick={() => onOpen("bets")}>View all</button></div><BetsTable bets={data.latestBets ?? []} loading={loading} onSelect={() => {}} compact /></section>
        <section className="admin-panel"><div className="admin-panel-heading"><div><span>WALLET QUEUE</span><h3>Recent withdrawals</h3></div><button type="button" onClick={() => onOpen("withdrawals")}>View all</button></div><WalletTable rows={data.latestWithdrawals ?? []} loading={loading} onSelect={() => {}} kind="withdrawal" compact /></section>
      </div>
    </div>
  );
}

function ProviderGames({ games, loading, settingsConfigured, onSaved }: { games: ProviderGame[]; loading: boolean; settingsConfigured: boolean; onSaved: () => void }) {
  const [editingCode, setEditingCode] = useState("");
  const [draft, setDraft] = useState({ image_url: "", players_online: "", sort_order: "", is_active: true });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [visibilitySavingCode, setVisibilitySavingCode] = useState("");
  const [visibilityOverrides, setVisibilityOverrides] = useState<Record<string, boolean>>({});
  const [visibilityError, setVisibilityError] = useState("");
  const [hotSavingCode, setHotSavingCode] = useState("");
  const [hotOverrides, setHotOverrides] = useState<Record<string, boolean>>({});
  const [hotError, setHotError] = useState("");

  useEffect(() => {
    setVisibilityOverrides((current) => {
      const next = { ...current };
      for (const [code, visible] of Object.entries(current)) {
        const game = games.find((item) => item.game_code === code);
        if (game && (game.is_active !== false) === visible) delete next[code];
      }
      return next;
    });
  }, [games]);

  useEffect(() => {
    setHotOverrides((current) => {
      const next = { ...current };
      for (const [code, hot] of Object.entries(current)) {
        const game = games.find((item) => item.game_code === code);
        if (game && (game.is_hot === true) === hot) delete next[code];
      }
      return next;
    });
  }, [games]);

  function isVisible(game: ProviderGame) {
    return visibilityOverrides[game.game_code] ?? game.is_active !== false;
  }

  function isHot(game: ProviderGame) {
    return hotOverrides[game.game_code] ?? game.is_hot === true;
  }

  async function toggleVisibility(game: ProviderGame) {
    const wasVisible = isVisible(game);
    const nextVisible = !wasVisible;
    setVisibilityOverrides((current) => ({ ...current, [game.game_code]: nextVisible }));
    setVisibilitySavingCode(game.game_code);
    setVisibilityError("");
    try {
      const response = await fetch("/api/admin", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "set_game_visibility",
          game_code: game.game_code,
          is_active: nextVisible,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Could not update game visibility");
      onSaved();
    } catch (reason) {
      setVisibilityOverrides((current) => ({ ...current, [game.game_code]: wasVisible }));
      setVisibilityError(reason instanceof Error ? reason.message : "Could not update game visibility");
    } finally {
      setVisibilitySavingCode("");
    }
  }

  async function toggleHot(game: ProviderGame) {
    const wasHot = isHot(game);
    const nextHot = !wasHot;
    setHotOverrides((current) => ({ ...current, [game.game_code]: nextHot }));
    setHotSavingCode(game.game_code);
    setHotError("");
    try {
      const response = await fetch("/api/admin", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set_game_hot", game_code: game.game_code, is_hot: nextHot }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Could not update hot status");
      onSaved();
    } catch (reason) {
      setHotOverrides((current) => ({ ...current, [game.game_code]: wasHot }));
      setHotError(reason instanceof Error ? reason.message : "Could not update hot status");
    } finally {
      setHotSavingCode("");
    }
  }

  function edit(game: ProviderGame) {
    setEditingCode(game.game_code);
    setSaveError("");
    setDraft({
      image_url: game.image_url ?? "",
      players_online: game.players_online == null ? "" : String(game.players_online),
      sort_order: String(game.sort_order ?? 0),
      is_active: isVisible(game),
    });
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setSaveError("");
    try {
      const response = await fetch("/api/admin", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save_game_settings",
          game_code: editingCode,
          image_url: draft.image_url,
          players_online: draft.players_online,
          sort_order: Number(draft.sort_order),
          is_active: draft.is_active,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Could not save game settings");
      setEditingCode("");
      onSaved();
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : "Could not save game settings");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="admin-game-heading"><div><span>LIVE PROVIDER CATALOG</span><h2>Manage games</h2><p>Edit artwork, player count, visibility, and order. Provider availability and stake levels stay synced.</p></div></div>
      {!settingsConfigured ? <div className="admin-error">Run <code>neon/006_game_display_settings.sql</code> in the Neon SQL Editor to enable game editing.</div> : null}
      {visibilityError ? <div className="admin-error" role="alert">{visibilityError}</div> : null}
      {hotError ? <div className="admin-error" role="alert">{hotError}</div> : null}
      <div className="admin-games-table-wrap"><table className="admin-table"><thead><tr><th>Game</th><th>Game code</th><th>MMK pools</th><th>MMK tables</th><th>Active players</th><th>Order</th><th>Visible</th><th>Hot</th><th /></tr></thead><tbody>
        {games.map((game) => {
          const pools = (game.pools ?? []).filter((pool) => pool.currency === "MMK");
          const tables = (game.tables ?? []).filter((table) => table.currency === "MMK");
          return <Fragment key={game.game_code}>
            <tr>
              <td><div className="admin-game-cell">{game.image_url ? <img src={game.image_url} alt="" /> : <span>{game.name.slice(0, 1)}</span>}<strong>{game.name}</strong></div></td>
              <td>{game.game_code}</td><td>{pools.length}</td><td>{tables.length}</td>
              <td>{game.players_online == null ? "—" : Number(game.players_online).toLocaleString()}</td>
              <td>{game.sort_order ?? "—"}</td><td><button
                type="button"
                className={`admin-game-visibility ${isVisible(game) ? "visible" : "hidden"}`}
                onClick={() => void toggleVisibility(game)}
                disabled={!settingsConfigured || visibilitySavingCode !== ""}
                aria-pressed={isVisible(game)}
                title={isVisible(game) ? "Click to hide this game" : "Click to show this game"}
              ><i aria-hidden="true" />{visibilitySavingCode === game.game_code ? "Saving…" : isVisible(game) ? "Visible" : "Hidden"}</button></td>
              <td><button
                type="button"
                className={`admin-game-hot ${isHot(game) ? "is-hot" : "not-hot"}`}
                onClick={() => void toggleHot(game)}
                disabled={!settingsConfigured || hotSavingCode !== ""}
                aria-pressed={isHot(game)}
                title={isHot(game) ? "Click to remove from popular games" : "Click to mark as popular"}
              ><i aria-hidden="true" />{hotSavingCode === game.game_code ? "Saving…" : isHot(game) ? "Hot" : "Not hot"}</button></td>
              <td><div className="admin-game-actions"><button type="button" onClick={() => edit(game)}>Edit</button></div></td>
            </tr>
            {editingCode === game.game_code ? (
              <tr key={`${game.game_code}-edit`}><td colSpan={9}>
                <form className="admin-game-form" onSubmit={(event) => void save(event)}>
                  <div className="admin-game-form-heading"><strong>Edit {game.name}</strong><button type="button" onClick={() => { setEditingCode(""); setSaveError(""); }}>Cancel</button></div>
                  <div className="admin-game-form-grid">
                    <label className="admin-game-image-field">Game image URL (HTTPS)
                      <input type="url" value={draft.image_url} onChange={(event) => setDraft((current) => ({ ...current, image_url: event.target.value }))} placeholder="https://…" />
                    </label>
                    <label>Active players
                      <input type="number" min="0" step="1" value={draft.players_online} onChange={(event) => setDraft((current) => ({ ...current, players_online: event.target.value }))} placeholder="Leave blank to hide" />
                    </label>
                    <label>Display order
                      <input type="number" min="0" max="1000000" step="1" value={draft.sort_order} onChange={(event) => setDraft((current) => ({ ...current, sort_order: event.target.value }))} required />
                    </label>
                    <label className="admin-game-check-label"><input type="checkbox" checked={draft.is_active} onChange={(event) => setDraft((current) => ({ ...current, is_active: event.target.checked }))} /> Show on homepage</label>
                  </div>
                  {saveError ? <p className="admin-game-error" role="alert">{saveError}</p> : null}
                  <div className="admin-game-form-actions"><button className="admin-add-game" type="submit" disabled={saving || !settingsConfigured}>{saving ? "Saving…" : "Save changes"}</button></div>
                </form>
              </td></tr>
            ) : null}
          </Fragment>;
        })}
        {!games.length ? <tr><td colSpan={9}><TableEmpty loading={loading} /></td></tr> : null}
      </tbody></table></div>
    </>
  );
}

function UsersTable({ users, loading, onSelect }: { users: UserRow[]; loading: boolean; onSelect: (id: string) => void }) {
  if (!users.length) return <TableEmpty loading={loading} />;
  return <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Player</th><th>Player ID</th><th>Balance</th><th>Joined</th><th /></tr></thead><tbody>{users.map((user) => <tr key={user.id} onClick={() => onSelect(user.id)}><td><strong>{user.phone}</strong></td><td>{user.id}</td><td className="admin-number">{money(user.balance)}</td><td>{date(user.created_at)}</td><td><button type="button" className="admin-row-action">Details →</button></td></tr>)}</tbody></table></div>;
}

function BetsTable({ bets, loading, onSelect, compact = false }: { bets: BetRow[]; loading: boolean; onSelect: (id: string) => void; compact?: boolean }) {
  if (!bets.length) return <TableEmpty loading={loading} />;
  return <div className={`admin-table-wrap${compact ? " compact" : ""}`}><table className="admin-table"><thead><tr><th>Player</th><th>Game / round</th><th>Stake / reserve</th><th title="Credit minus unused reserve; can be negative for multiplier losses">Win</th><th>Net result</th><th>Status</th><th>Date</th></tr></thead><tbody>{bets.map((bet) => <tr key={bet.bet_uid}>
    <td><button type="button" className="admin-player-link" onClick={() => onSelect(bet.user_id)}>{bet.phone}</button><small>{bet.transaction_id ?? bet.bet_uid}</small></td>
    <td>{bet.game_code ?? (bet.game_id ? `Game ${bet.game_id}` : "Legacy game")}<small>{bet.activity_type === "banker" ? "Banker · " : ""}{bet.round_id || "—"}</small></td>
    <td className="admin-number">{money(bet.activity_type === "banker" ? bet.held_amount : bet.bet)}<small>{bet.activity_type === "banker" ? "Reserved bank" : Number(bet.held_amount) > Number(bet.bet) ? `Held: ${money(bet.held_amount)}` : "Stake"}</small></td>
    <td className="admin-number">{bet.win == null ? "—" : money(bet.win)}</td>
    <td className={`admin-number${Number(bet.changemoney) > 0 ? " admin-win" : Number(bet.changemoney) < 0 ? " admin-loss" : ""}`}>{bet.changemoney == null ? "—" : money(bet.changemoney)}</td>
    <td><Status value={bet.status ?? "settled"} /></td><td>{date(bet.created_at)}{bet.settled_at && !compact ? <small>Closed: {date(bet.settled_at)}</small> : null}</td>
  </tr>)}</tbody></table></div>;
}

function WalletTable({ rows, loading, onSelect, kind, compact = false }: { rows: WalletRow[]; loading: boolean; onSelect: (id: string) => void; kind: "deposit" | "withdrawal"; compact?: boolean }) {
  if (!rows.length) return <TableEmpty loading={loading} />;
  return <div className={`admin-table-wrap${compact ? " compact" : ""}`}><table className="admin-table"><thead><tr><th>Player</th><th>Method</th><th>{kind === "deposit" ? "Receipt reference" : "Payout phone"}</th><th>Amount</th><th>Status</th><th>Date</th></tr></thead><tbody>{rows.map((row) => <tr key={row.order_id}><td><button type="button" className="admin-player-link" onClick={() => onSelect(row.user_id)}>{row.phone}</button><small>{row.order_id}</small></td><td>{row.service_type === "kbzpay" ? "KBZPay" : "WavePay"}</td><td>{row.reference || row.payout_phone || row.provider_txn_id || "—"}</td><td className="admin-number">{money(row.amount)}{Number(row.bonus_amount) > 0 ? <small>Bonus +{money(row.bonus_amount)}</small> : null}</td><td><Status value={row.status} /></td><td>{date(row.created_at)}</td></tr>)}</tbody></table></div>;
}

function DetailBets({ bets }: { bets: BetRow[] }) {
  return <section className="admin-panel"><div className="admin-panel-heading"><div><span>PLAYER ACTIVITY</span><h3>Recent game activity</h3></div></div>{bets.length ? <div className="admin-detail-records">{bets.map((bet) => <div key={bet.bet_uid}><span>{bet.game_code ?? "Legacy game"}<small>{date(bet.created_at)} · {bet.status ?? "settled"}</small><small>Round {bet.round_id || "—"}</small></span><strong>{bet.activity_type === "banker" ? `Reserved ${money(bet.held_amount)}` : `Stake ${money(bet.bet)}`}<small>Net {bet.changemoney == null ? "—" : money(bet.changemoney)}</small></strong></div>)}</div> : <TableEmpty loading={false} />}</section>;
}

function DetailWallet({ title, rows }: { title: string; rows: WalletRow[] }) {
  return <section className="admin-panel"><div className="admin-panel-heading"><div><span>PLAYER WALLET</span><h3>{title}</h3></div></div>{rows.length ? <div className="admin-detail-records">{rows.map((row) => <div key={row.order_id}><span>{row.service_type === "kbzpay" ? "KBZPay" : "WavePay"}<small>{date(row.created_at)}</small></span><strong>{money(row.amount)}{Number(row.bonus_amount) > 0 ? <small>Bonus +{money(row.bonus_amount)}</small> : null}<small><Status value={row.status} /></small></strong></div>)}</div> : <TableEmpty loading={false} />}</section>;
}
