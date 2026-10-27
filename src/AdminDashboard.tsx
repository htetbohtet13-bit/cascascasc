import { useEffect, useState, type FormEvent } from "react";

type Section = "overview" | "users" | "games" | "bets" | "deposits" | "withdrawals";
type UserRow = { id: string; phone: string; balance: number | string; game_uid: string; created_at: string };
type BetRow = {
  bet_uid: string; round_id: string | null; bet: number | string; win: number | string;
  changemoney?: number | string; balance_after?: number | string; game_id?: number | null;
  created_at: string; user_id: string; phone: string; game_uid?: string;
};
type WalletRow = {
  order_id: string; user_id: string; phone: string; game_uid: string; service_type: string;
  amount: number | string; status: string; message: string | null; created_at: string;
  completed_at: string | null; provider_txn_id?: string | null; payout_phone?: string | null; reference?: string | null;
};
type Summary = Record<string, number | string>;
type AdminGame = {
  id: number | string; game_id: number; room_id: number; name: string; category: string;
  image_url: string | null; gradient_start: string; gradient_end: string;
  players_online: number | null; is_popular: boolean; is_active: boolean; sort_order: number;
};
type Payload = {
  summary?: Summary; latestBets?: BetRow[]; latestWithdrawals?: WalletRow[];
  users?: UserRow[]; games?: AdminGame[]; bets?: BetRow[]; deposits?: WalletRow[]; withdrawals?: WalletRow[];
  user?: UserRow; total?: number; page?: number; pageSize?: number;
};
type UserDetail = Payload & { user: UserRow; bets: BetRow[]; deposits: WalletRow[]; withdrawals: WalletRow[] };

const SECTIONS: { id: Section; label: string; mark: string }[] = [
  { id: "overview", label: "Overview", mark: "▦" },
  { id: "users", label: "Players", mark: "♙" },
  { id: "games", label: "Games", mark: "▣" },
  { id: "bets", label: "Bet history", mark: "♧" },
  { id: "deposits", label: "Deposits", mark: "＋" },
  { id: "withdrawals", label: "Withdrawals", mark: "↓" },
];

function money(value: number | string | null | undefined) {
  return `${Number(value ?? 0).toLocaleString("en-US")} Ks`;
}

function date(value: string | null | undefined) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
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
  const [data, setData] = useState<Payload | UserDetail>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [authCode, setAuthCode] = useState(0);
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      const view = selectedUserId ? "user" : section;
      const params = new URLSearchParams({ view });
      if (selectedUserId) params.set("user_id", selectedUserId);
      if (section !== "overview" && !selectedUserId) {
        params.set("page", String(page));
        if (search.trim()) params.set("search", search.trim());
        if ((section === "deposits" || section === "withdrawals") && status) params.set("status", status);
      }
      setLoading(true);
      setError("");
      setAuthCode(0);
      fetch(`/api/admin?${params.toString()}`, { credentials: "include" })
        .then(async (response) => {
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) {
            const failure = new Error(payload.error || "Could not load dashboard data") as Error & { status?: number };
            failure.status = response.status;
            throw failure;
          }
          return payload;
        })
        .then((payload) => {
          if (active) setData(payload);
        })
        .catch((reason: Error & { status?: number }) => {
          if (!active) return;
          setError(reason.message || "Could not load dashboard data");
          setAuthCode(reason.status || 0);
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 220);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [section, selectedUserId, search, status, page, refreshKey]);

  function changeSection(next: Section) {
    setSection(next);
    setSelectedUserId("");
    setPage(1);
    setStatus("");
    setSearch("");
  }

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoginError("");
    setLoginBusy(true);
    try {
      const response = await fetch("/api/admin", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "login", password: loginPassword }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Could not sign in");
      setLoginPassword("");
      setAuthCode(0);
      setError("");
      setRefreshKey((value) => value + 1);
    } catch (reason) {
      setLoginError(reason instanceof Error ? reason.message : "Could not sign in");
    } finally {
      setLoginBusy(false);
    }
  }

  async function logout() {
    await fetch("/api/admin", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "logout" }),
    }).catch(() => {});
    setData({});
    setLoginPassword("");
    setAuthCode(401);
  }

  const total = data.total ?? 0;
  const pageSize = data.pageSize ?? 50;
  const canGoBack = page > 1;
  const canGoNext = page * pageSize < total;
  const detail = selectedUserId ? data as UserDetail : null;

  if (authCode === 401 || authCode === 503) {
    return (
      <main className="admin-gate">
        <div className="admin-gate-card">
          <div className="admin-brand-mark">777</div>
          <h1>{authCode === 401 ? "Admin sign-in" : "Admin password is not set"}</h1>
          {authCode === 401 ? (
            <>
              <p>Enter the admin password to continue.</p>
              <form className="admin-login-form" onSubmit={(event) => void login(event)}>
                <label htmlFor="admin-secret">Admin password</label>
                <input id="admin-secret" type="password" value={loginPassword} onChange={(event) => setLoginPassword(event.target.value)} autoComplete="current-password" autoFocus required />
                {loginError ? <span role="alert">{loginError}</span> : null}
                <button className="admin-gate-button" type="submit" disabled={loginBusy}>{loginBusy ? "Checking…" : "Log in"}</button>
              </form>
            </>
          ) : (
            <>
              <p>{error}</p>
              <p className="admin-setup-note">Set a long password in the server-only <code>admin_secret</code> environment variable in Vercel, then redeploy.</p>
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
              <div className="admin-detail-card"><small>Game account ID</small><strong>{detail.user.game_uid}</strong></div>
              <div className="admin-detail-card"><small>Joined</small><strong>{date(detail.user.created_at)}</strong></div>
              <div className="admin-detail-card"><small>Total bets shown</small><strong>{detail.bets?.length ?? 0}</strong></div>
            </div>
            <div className="admin-detail-sections">
              <DetailBets bets={detail.bets ?? []} />
              <DetailWallet title="Deposits" rows={detail.deposits ?? []} />
              <DetailWallet title="Withdrawals" rows={detail.withdrawals ?? []} />
            </div>
          </div>
        ) : section === "overview" ? (
          <Overview data={data} loading={loading} onOpen={changeSection} />
        ) : section === "games" ? (
          <div className="admin-page-content"><GameManager games={(data as Payload).games ?? []} loading={loading} onRefresh={() => setRefreshKey((value) => value + 1)} /></div>
        ) : (
          <div className="admin-page-content">
            <div className="admin-list-toolbar">
              <label className="admin-search"><span aria-hidden="true">⌕</span><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder={section === "users" ? "Search phone, game ID, or player ID" : "Search player, round, or reference"} /></label>
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

function Overview({ data, loading, onOpen }: { data: Payload; loading: boolean; onOpen: (section: Section) => void }) {
  const summary = data.summary ?? {};
  const cards = [
    ["Players", summary.users, "New today", summary.new_users_today, "users"],
    ["Total player balance", money(summary.total_balance), "All active wallets", "", "users"],
    ["Bet volume", money(summary.bet_total), "Payouts", money(summary.win_total), "bets"],
    ["Deposits", money(summary.deposit_total), "Transactions", summary.deposit_count, "deposits"],
    ["Withdrawals paid", money(summary.withdrawal_total), "Pending requests", summary.pending_withdrawals, "withdrawals"],
    ["Game catalog", summary.active_games, "Total games", summary.games_total, "games"],
  ] as const;
  return (
    <div className="admin-page-content">
      <div className="admin-welcome"><div><span>BUSINESS OVERVIEW</span><h2>Casino activity at a glance</h2><p>Player accounts, game activity, and wallet movement.</p></div><div className="admin-welcome-icon">✦</div></div>
      <div className="admin-stat-grid">
        {cards.map(([label, value, note, sub, target]) => (
          <button key={label} className="admin-stat-card" type="button" onClick={() => onOpen(target as Section)}>
            <span>{label}</span><strong>{loading ? "—" : typeof value === "number" || typeof value === "string" ? value : "0"}</strong><small>{note}: {sub || "—"}</small>
          </button>
        ))}
        <button className="admin-stat-card" type="button" onClick={() => onOpen("bets")}><span>Bet records</span><strong>{loading ? "—" : Number(summary.bet_count ?? 0).toLocaleString()}</strong><small>Open bet history</small></button>
      </div>
      <div className="admin-overview-columns">
        <section className="admin-panel"><div className="admin-panel-heading"><div><span>LATEST ACTIVITY</span><h3>Recent bets</h3></div><button type="button" onClick={() => onOpen("bets")}>View all</button></div><BetsTable bets={data.latestBets ?? []} loading={loading} onSelect={() => {}} compact /></section>
        <section className="admin-panel"><div className="admin-panel-heading"><div><span>WALLET QUEUE</span><h3>Recent withdrawals</h3></div><button type="button" onClick={() => onOpen("withdrawals")}>View all</button></div><WalletTable rows={data.latestWithdrawals ?? []} loading={loading} onSelect={() => {}} kind="withdrawal" compact /></section>
      </div>
    </div>
  );
}

const EMPTY_GAME: Omit<AdminGame, "id"> = {
  game_id: 1, room_id: 1, name: "", category: "slots", image_url: "",
  gradient_start: "#5c3918", gradient_end: "#d59612", players_online: null,
  is_popular: false, is_active: true, sort_order: 0,
};

function GameManager({ games, loading, onRefresh }: { games: AdminGame[]; loading: boolean; onRefresh: () => void }) {
  const [editing, setEditing] = useState<AdminGame | null>(null);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  async function saveGame(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const game = {
      ...(editing ?? EMPTY_GAME),
      name: String(form.get("name") ?? "").trim(),
      game_id: Number(form.get("game_id")),
      room_id: Number(form.get("room_id")),
      category: String(form.get("category") ?? "slots"),
      image_url: String(form.get("image_url") ?? "").trim(),
      gradient_start: String(form.get("gradient_start") ?? "#5c3918"),
      gradient_end: String(form.get("gradient_end") ?? "#d59612"),
      players_online: String(form.get("players_online") ?? "") === "" ? null : Number(form.get("players_online")),
      sort_order: Number(form.get("sort_order") ?? 0),
      is_popular: form.get("is_popular") === "on",
      is_active: form.get("is_active") === "on",
    };
    setSaving(true);
    setMessage("");
    try {
      const response = await fetch("/api/admin", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: editing ? "update_game" : "create_game", ...game }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Could not save game");
      setEditing(null);
      setCreating(false);
      onRefresh();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "Could not save game");
    } finally {
      setSaving(false);
    }
  }

  async function deleteGame(game: AdminGame) {
    if (!window.confirm(`Remove ${game.name} from the game list?`)) return;
    setMessage("");
    try {
      const response = await fetch("/api/admin", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete_game", id: game.id }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Could not remove game");
      onRefresh();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "Could not remove game");
    }
  }

  const initial = editing ?? EMPTY_GAME;
  return (
    <>
      <div className="admin-game-heading"><div><span>GAME CATALOG</span><h2>Manage games</h2><p>Add a game provider ID, its room, artwork, and display settings.</p></div><button className="admin-add-game" type="button" onClick={() => { setEditing(null); setCreating((value) => !value); setMessage(""); }}>{creating ? "Cancel" : "+ Add game"}</button></div>
      {creating || editing ? (
        <form key={editing ? `edit-${editing.id}` : "new-game"} className="admin-game-form" onSubmit={(event) => void saveGame(event)}>
          <div className="admin-game-form-heading"><strong>{editing ? "Edit game" : "New game"}</strong><button type="button" onClick={() => { setEditing(null); setCreating(false); }}>Cancel</button></div>
          <label>Game name<input name="name" defaultValue={initial.name} maxLength={80} required placeholder="Example: Charge Buffalo" /></label>
          <div className="admin-game-form-grid">
            <label>Game ID<input name="game_id" type="number" min="1" step="1" defaultValue={initial.game_id} required /></label>
            <label>Room ID<input name="room_id" type="number" min="1" step="1" defaultValue={initial.room_id} required /></label>
            <label>Category<select name="category" defaultValue={initial.category}><option value="slots">Slots</option><option value="cards">Cards</option><option value="buffalo">Buffalo</option><option value="other">Other</option></select></label>
            <label>Sort order<input name="sort_order" type="number" step="1" defaultValue={initial.sort_order} /></label>
          </div>
          <label>Game image URL<input name="image_url" type="text" defaultValue={initial.image_url ?? ""} placeholder="https://… or /images/game.png" /></label>
          <div className="admin-game-form-grid">
            <label>Gradient start<input name="gradient_start" type="color" defaultValue={initial.gradient_start} /></label>
            <label>Gradient end<input name="gradient_end" type="color" defaultValue={initial.gradient_end} /></label>
            <label>Players online (optional)<input name="players_online" type="number" min="0" step="1" defaultValue={initial.players_online ?? ""} placeholder="Leave empty to hide" /></label>
          </div>
          <div className="admin-game-checks"><label><input name="is_popular" type="checkbox" defaultChecked={initial.is_popular} /> Show in Popular</label><label><input name="is_active" type="checkbox" defaultChecked={initial.is_active} /> Visible on site</label></div>
          {message ? <p className="admin-game-error">{message}</p> : null}
          <button className="admin-add-game" type="submit" disabled={saving}>{saving ? "Saving…" : editing ? "Save changes" : "Add game"}</button>
        </form>
      ) : null}
      {message && !creating && !editing ? <p className="admin-game-error">{message}</p> : null}
      <div className="admin-games-table-wrap"><table className="admin-table"><thead><tr><th>Game</th><th>Provider ID</th><th>Room</th><th>Category</th><th>Popular</th><th>Visibility</th><th /></tr></thead><tbody>
        {games.map((game) => <tr key={game.id}><td><div className="admin-game-cell">{game.image_url ? <img src={game.image_url} alt="" /> : <span style={{ background: `linear-gradient(145deg, ${game.gradient_start}, ${game.gradient_end})` }}>{game.name.slice(0, 1)}</span>}<strong>{game.name}</strong></div></td><td>{game.game_id}</td><td>{game.room_id}</td><td>{game.category}</td><td>{game.is_popular ? "Yes" : "—"}</td><td><Status value={game.is_active ? "active" : "inactive"} /></td><td><div className="admin-game-actions"><button type="button" onClick={() => { setCreating(false); setEditing(game); setMessage(""); }}>Edit</button><button type="button" className="delete" onClick={() => void deleteGame(game)}>Remove</button></div></td></tr>)}
        {!games.length ? <tr><td colSpan={7}><TableEmpty loading={loading} /></td></tr> : null}
      </tbody></table></div>
    </>
  );
}

function UsersTable({ users, loading, onSelect }: { users: UserRow[]; loading: boolean; onSelect: (id: string) => void }) {
  if (!users.length) return <TableEmpty loading={loading} />;
  return <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Player</th><th>Game ID</th><th>Balance</th><th>Joined</th><th /></tr></thead><tbody>{users.map((user) => <tr key={user.id} onClick={() => onSelect(user.id)}><td><strong>{user.phone}</strong><small>{user.id}</small></td><td>{user.game_uid}</td><td className="admin-number">{money(user.balance)}</td><td>{date(user.created_at)}</td><td><button type="button" className="admin-row-action">Details →</button></td></tr>)}</tbody></table></div>;
}

function BetsTable({ bets, loading, onSelect, compact = false }: { bets: BetRow[]; loading: boolean; onSelect: (id: string) => void; compact?: boolean }) {
  if (!bets.length) return <TableEmpty loading={loading} />;
  return <div className={`admin-table-wrap${compact ? " compact" : ""}`}><table className="admin-table"><thead><tr><th>Player</th><th>Bet</th><th>Win</th><th>Round</th><th>Date</th></tr></thead><tbody>{bets.map((bet) => <tr key={bet.bet_uid}><td><button type="button" className="admin-player-link" onClick={() => onSelect(bet.user_id)}>{bet.phone}</button><small>{bet.bet_uid}</small></td><td className="admin-number">{money(bet.bet)}</td><td className="admin-number admin-win">{money(bet.win)}</td><td>{bet.round_id || "—"}</td><td>{date(bet.created_at)}</td></tr>)}</tbody></table></div>;
}

function WalletTable({ rows, loading, onSelect, kind, compact = false }: { rows: WalletRow[]; loading: boolean; onSelect: (id: string) => void; kind: "deposit" | "withdrawal"; compact?: boolean }) {
  if (!rows.length) return <TableEmpty loading={loading} />;
  return <div className={`admin-table-wrap${compact ? " compact" : ""}`}><table className="admin-table"><thead><tr><th>Player</th><th>Method</th><th>{kind === "deposit" ? "Receipt reference" : "Payout phone"}</th><th>Amount</th><th>Status</th><th>Date</th></tr></thead><tbody>{rows.map((row) => <tr key={row.order_id}><td><button type="button" className="admin-player-link" onClick={() => onSelect(row.user_id)}>{row.phone}</button><small>{row.order_id}</small></td><td>{row.service_type === "kbzpay" ? "KBZPay" : "WavePay"}</td><td>{row.reference || row.payout_phone || row.provider_txn_id || "—"}</td><td className="admin-number">{money(row.amount)}</td><td><Status value={row.status} /></td><td>{date(row.created_at)}</td></tr>)}</tbody></table></div>;
}

function DetailBets({ bets }: { bets: BetRow[] }) {
  return <section className="admin-panel"><div className="admin-panel-heading"><div><span>PLAYER ACTIVITY</span><h3>Recent bets</h3></div></div>{bets.length ? <div className="admin-detail-records">{bets.map((bet) => <div key={bet.bet_uid}><span>{date(bet.created_at)}<small>Round {bet.round_id || "—"}</small></span><strong>Bet {money(bet.bet)}<small>Win {money(bet.win)}</small></strong></div>)}</div> : <TableEmpty loading={false} />}</section>;
}

function DetailWallet({ title, rows }: { title: string; rows: WalletRow[] }) {
  return <section className="admin-panel"><div className="admin-panel-heading"><div><span>PLAYER WALLET</span><h3>{title}</h3></div></div>{rows.length ? <div className="admin-detail-records">{rows.map((row) => <div key={row.order_id}><span>{row.service_type === "kbzpay" ? "KBZPay" : "WavePay"}<small>{date(row.created_at)}</small></span><strong>{money(row.amount)}<small><Status value={row.status} /></small></strong></div>)}</div> : <TableEmpty loading={false} />}</section>;
}
