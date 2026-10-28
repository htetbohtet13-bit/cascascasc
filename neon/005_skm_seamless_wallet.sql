-- Shan Koe Mee provider: seamless game sessions and idempotent wallet ledger.
-- Run this once in the Neon SQL Editor before deploying the new provider callbacks.

begin;

create table if not exists public.skm_game_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  is_active boolean not null default true,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists skm_game_sessions_user_recent_idx
  on public.skm_game_sessions (user_id, created_at desc);

create unique index if not exists skm_game_sessions_one_active_per_user_idx
  on public.skm_game_sessions (user_id)
  where is_active = true;

create table if not exists public.skm_wallet_transactions (
  id uuid primary key default gen_random_uuid(),
  transaction_id text not null unique
    check (char_length(transaction_id) between 1 and 160),
  user_id uuid not null references public.profiles (id) on delete restrict,
  player_id text not null,
  currency text not null check (currency = 'MMK'),
  kind text not null check (kind in ('DEBIT', 'CREDIT', 'ROLLBACK')),
  reason text not null check (reason in ('BET_HOLD', 'BET_SETTLE', 'BANK_DEPOSIT', 'BANK_RETURN')),
  amount bigint not null check (amount between 0 and 9007199254740991),
  round_id text not null check (char_length(round_id) between 1 and 160),
  game_code text not null check (char_length(game_code) between 1 and 80),
  debit_transaction_id text check (debit_transaction_id is null or char_length(debit_transaction_id) between 1 and 160),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('APPLIED', 'TOMBSTONE', 'SETTLED', 'ROLLED_BACK')),
  balance_after bigint not null check (balance_after between 0 and 9007199254740991),
  created_at timestamptz not null default now()
);

create index if not exists skm_wallet_transactions_user_recent_idx
  on public.skm_wallet_transactions (user_id, created_at desc);

create index if not exists skm_wallet_transactions_round_idx
  on public.skm_wallet_transactions (round_id, game_code);

create unique index if not exists skm_wallet_transactions_close_debit_idx
  on public.skm_wallet_transactions (debit_transaction_id)
  where kind in ('CREDIT', 'ROLLBACK') and debit_transaction_id is not null;

-- The live game list now comes from the provider API. Remove the legacy Buffalo catalog rows;
-- old slot_bets and wallet history are retained for audit purposes.
delete from public.games;

commit;

select table_name
  from information_schema.tables
 where table_schema = 'public'
   and table_name in ('skm_game_sessions', 'skm_wallet_transactions');

select count(*) as remaining_legacy_games from public.games;
