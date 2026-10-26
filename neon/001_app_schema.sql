-- Neon schema bootstrap for the casino app's application data.
-- Run once against an EMPTY Neon database/branch using the Neon SQL Editor.
-- This intentionally does not create Supabase auth.users, RLS policies,
-- Supabase triggers, or Edge Function RPCs; those need app/backend migration.

begin;

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key default gen_random_uuid(),
  phone text not null unique,
  balance bigint not null default 0 check (balance >= 0),
  game_uid text not null unique
    default replace(gen_random_uuid()::text, '-', ''),
  created_at timestamptz not null default now(),
  constraint profiles_phone_e164
    check (phone ~ '^[+][1-9][0-9]{7,14}$'),
  constraint profiles_game_uid_length
    check (char_length(game_uid) > 0 and char_length(game_uid) <= 50)
);

create table if not exists public.game_tokens (
  uid text primary key
    references public.profiles (game_uid) on delete cascade,
  user_id uuid not null unique
    references public.profiles (id) on delete cascade,
  token text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz
);

create table if not exists public.slot_bets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null
    references public.profiles (id) on delete cascade,
  uid text not null,
  round_id text,
  bet_uid text not null unique,
  changemoney bigint not null,
  bet bigint not null check (bet >= 0),
  win bigint not null check (win >= 0),
  room_id integer,
  game_id integer,
  balance_after bigint not null,
  created_at timestamptz not null default now()
);

create index if not exists slot_bets_user_created_idx
  on public.slot_bets (user_id, created_at desc);

create table if not exists public.wallet_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null
    references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('deposit', 'withdraw')),
  service_type text not null check (service_type in ('kbzpay', 'wavepay')),
  order_id text not null unique,
  amount bigint not null check (amount > 0),
  transaction_id text,
  provider_txn_id text,
  deposit_token text,
  payout_phone text,
  status text not null check (status in ('pending', 'verified', 'failed', 'paid')),
  message text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists wallet_orders_user_created_idx
  on public.wallet_orders (user_id, created_at desc);

create unique index if not exists wallet_orders_verified_tx_uidx
  on public.wallet_orders (transaction_id)
  where kind = 'deposit'
    and status = 'verified'
    and transaction_id is not null;

create unique index if not exists wallet_orders_paid_withdraw_txn_uidx
  on public.wallet_orders (provider_txn_id)
  where kind = 'withdraw'
    and status = 'paid'
    and provider_txn_id is not null;

commit;

-- Quick verification after running:
-- select table_name from information_schema.tables
-- where table_schema = 'public'
--   and table_name in ('profiles', 'game_tokens', 'slot_bets', 'wallet_orders')
-- order by table_name;
