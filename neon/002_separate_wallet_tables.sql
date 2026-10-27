-- Run this on the EXISTING Neon database before deploying the app update.
-- Creates clean, separate tables. It intentionally leaves wallet_orders untouched.

begin;

create extension if not exists pgcrypto;

create table if not exists public.deposits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  service_type text not null check (service_type in ('kbzpay', 'wavepay')),
  order_id text not null unique,
  amount bigint not null check (amount > 0),
  transaction_id text,
  provider_txn_id text,
  deposit_token text,
  status text not null check (status in ('pending', 'verified', 'failed')),
  message text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists deposits_user_created_idx
  on public.deposits (user_id, created_at desc);

create unique index if not exists deposits_transaction_id_uidx
  on public.deposits (transaction_id)
  where transaction_id is not null;

create table if not exists public.withdrawals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  service_type text not null check (service_type in ('kbzpay', 'wavepay')),
  order_id text not null unique,
  amount bigint not null check (amount > 0),
  provider_txn_id text,
  payout_phone text not null,
  status text not null check (status in ('pending', 'failed', 'paid')),
  message text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists withdrawals_user_created_idx
  on public.withdrawals (user_id, created_at desc);

create index if not exists withdrawals_user_pending_idx
  on public.withdrawals (user_id, created_at desc)
  where status = 'pending';

create unique index if not exists withdrawals_provider_txn_id_uidx
  on public.withdrawals (provider_txn_id)
  where provider_txn_id is not null;

revoke all on public.deposits, public.withdrawals from public;

commit;

-- Confirm both new tables exist before deploying the app update:
select table_name
  from information_schema.tables
 where table_schema = 'public'
   and table_name in ('deposits', 'withdrawals')
 order by table_name;
