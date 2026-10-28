-- Activates 1x turnover for deposits credited after this migration.
-- Historical deposits and bets are intentionally not backfilled.
begin;

create table if not exists public.wallet_wagering_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete restrict,
  kind text not null check (kind in ('DEPOSIT', 'BET', 'RESET')),
  amount bigint not null check (amount between 0 and 9007199254740991),
  source_id text not null check (char_length(source_id) between 1 and 240),
  state text not null check (state in ('PENDING', 'SETTLED', 'CANCELLED')),
  created_at timestamptz not null default now(),
  unique (kind, source_id),
  check (
    (kind = 'BET' and amount > 0)
    or (kind = 'DEPOSIT' and amount > 0 and state = 'SETTLED')
    or (kind = 'RESET' and amount = 0 and state = 'SETTLED')
  )
);

create index if not exists wallet_wagering_events_user_order_idx
  on public.wallet_wagering_events (user_id, id);
create index if not exists wallet_wagering_events_user_reset_idx
  on public.wallet_wagering_events (user_id, id desc) where kind = 'RESET';
create index if not exists skm_wallet_transactions_open_debit_idx
  on public.skm_wallet_transactions (user_id) where kind = 'DEBIT' and status = 'APPLIED';

revoke all on public.wallet_wagering_events from public;
revoke all on sequence public.wallet_wagering_events_id_seq from public;

commit;
