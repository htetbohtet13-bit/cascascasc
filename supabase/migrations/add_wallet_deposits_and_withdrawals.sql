create table public.wallet_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
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

create index wallet_orders_user_created_idx
  on public.wallet_orders (user_id, created_at desc);

create unique index wallet_orders_verified_tx_uidx
  on public.wallet_orders (transaction_id)
  where kind = 'deposit'
    and status = 'verified'
    and transaction_id is not null;

alter table public.wallet_orders enable row level security;
alter table public.wallet_orders force row level security;

create policy "Users can read own wallet orders"
  on public.wallet_orders
  for select
  to authenticated
  using (user_id = (select auth.uid()));

grant select on table public.wallet_orders to authenticated;
revoke insert, update, delete on table public.wallet_orders from anon, authenticated;

create or replace function public.apply_verified_deposit(
  p_user_id uuid,
  p_order_id text,
  p_service_type text,
  p_amount bigint,
  p_transaction_id text,
  p_provider_txn_id text,
  p_deposit_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_balance bigint;
  v_existing public.wallet_orders;
begin
  if p_user_id is null or coalesce(p_order_id, '') = '' then
    return jsonb_build_object('ok', false, 'message', 'Missing deposit details');
  end if;

  if p_service_type not in ('kbzpay', 'wavepay') then
    return jsonb_build_object('ok', false, 'message', 'Invalid payment method');
  end if;

  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('ok', false, 'message', 'Invalid amount');
  end if;

  if coalesce(p_transaction_id, '') !~ '^\d{6}$' then
    return jsonb_build_object('ok', false, 'message', 'Enter the last 6 digits');
  end if;

  select * into v_existing
  from public.wallet_orders
  where order_id = p_order_id;

  if found then
    if v_existing.user_id = p_user_id and v_existing.status = 'verified' then
      select balance into v_balance from public.profiles where id = p_user_id;
      return jsonb_build_object(
        'ok', true,
        'balance', v_balance,
        'message', 'Deposit already added',
        'order_id', p_order_id
      );
    end if;
    return jsonb_build_object('ok', false, 'message', 'Order already used');
  end if;

  select balance into v_balance
  from public.profiles
  where id = p_user_id
  for update;

  if v_balance is null then
    return jsonb_build_object('ok', false, 'message', 'Profile not found');
  end if;

  if exists (
    select 1
    from public.wallet_orders
    where kind = 'deposit'
      and status = 'verified'
      and transaction_id = p_transaction_id
  ) then
    return jsonb_build_object('ok', false, 'message', 'Transaction ID already used');
  end if;

  update public.profiles
  set balance = balance + p_amount
  where id = p_user_id
  returning balance into v_balance;

  insert into public.wallet_orders (
    user_id, kind, service_type, order_id, amount, transaction_id,
    provider_txn_id, deposit_token, status, message, completed_at
  ) values (
    p_user_id, 'deposit', p_service_type, p_order_id, p_amount, p_transaction_id,
    p_provider_txn_id, p_deposit_token, 'verified', 'success', now()
  );

  return jsonb_build_object(
    'ok', true,
    'balance', v_balance,
    'message', 'Deposit added',
    'order_id', p_order_id
  );
end;
$$;

create or replace function public.apply_withdraw(
  p_user_id uuid,
  p_order_id text,
  p_service_type text,
  p_amount bigint,
  p_payout_phone text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_balance bigint;
begin
  if p_user_id is null or coalesce(p_order_id, '') = '' then
    return jsonb_build_object('ok', false, 'message', 'Missing withdraw details');
  end if;

  if p_service_type not in ('kbzpay', 'wavepay') then
    return jsonb_build_object('ok', false, 'message', 'Invalid payment method');
  end if;

  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('ok', false, 'message', 'Invalid amount');
  end if;

  if coalesce(p_payout_phone, '') = '' then
    return jsonb_build_object('ok', false, 'message', 'Enter the phone number to receive money');
  end if;

  select balance into v_balance
  from public.profiles
  where id = p_user_id
  for update;

  if v_balance is null then
    return jsonb_build_object('ok', false, 'message', 'Profile not found');
  end if;

  if v_balance < p_amount then
    return jsonb_build_object('ok', false, 'message', 'Not enough balance');
  end if;

  update public.profiles
  set balance = balance - p_amount
  where id = p_user_id
  returning balance into v_balance;

  insert into public.wallet_orders (
    user_id, kind, service_type, order_id, amount, payout_phone,
    status, message, completed_at
  ) values (
    p_user_id, 'withdraw', p_service_type, p_order_id, p_amount, p_payout_phone,
    'pending', 'Withdraw requested', now()
  );

  return jsonb_build_object(
    'ok', true,
    'balance', v_balance,
    'message', 'Withdraw requested',
    'order_id', p_order_id
  );
end;
$$;

revoke all on function public.apply_verified_deposit(uuid, text, text, bigint, text, text, text) from public, anon, authenticated;
revoke all on function public.apply_withdraw(uuid, text, text, bigint, text) from public, anon, authenticated;
grant execute on function public.apply_verified_deposit(uuid, text, text, bigint, text, text, text) to service_role;
grant execute on function public.apply_withdraw(uuid, text, text, bigint, text) to service_role;
