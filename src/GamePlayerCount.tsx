import { useEffect, useState, type FormEvent } from "react";
import { playerCountLabel } from "./lib/player-count";

type Props = {
  code: string; min?: number | null; max?: number | null; sortOrder?: number;
  disabled: boolean; onSaved: () => void;
};

export default function GamePlayerCount({ code, min, max, sortOrder = 0, disabled, onSaved }: Props) {
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(() => playerCountLabel(min, max));
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setSaved(playerCountLabel(min, max)); }, [min, max]);
  useEffect(() => { if (disabled) setEditing(false); }, [disabled]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (saving || disabled) return;
    setSaving(true); setError("");
    try {
      const response = await fetch("/api/admin", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set_game_players", game_code: code, players_online: draft, sort_order: sortOrder }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok !== true) throw new Error(result.error || "Could not update player count");
      setSaved(playerCountLabel(result.players_online, result.players_online_max));
      setEditing(false); onSaved();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not update player count"); }
    finally { setSaving(false); }
  }

  if (!editing) return <button type="button" className="admin-player-count" disabled={disabled} title="Edit player count" aria-label={`Edit players for ${code}`} onClick={() => { setDraft(saved); setError(""); setEditing(true); }}><span>{saved || "—"}</span><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15v5Z" /></svg></button>;
  return <form className="admin-player-count-form" onSubmit={(event) => void save(event)} onKeyDown={(event) => { if (event.key === "Escape" && !saving) { event.preventDefault(); setEditing(false); } }}>
    <input aria-label={`Player count for ${code}`} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="100-500" maxLength={32} disabled={saving} autoFocus />
    <button type="submit" disabled={saving}>{saving ? "Saving…" : "Save"}</button>
    <button type="button" disabled={saving} onClick={() => setEditing(false)}>Cancel</button>
    {error ? <small role="alert">{error}</small> : null}
  </form>;
}
