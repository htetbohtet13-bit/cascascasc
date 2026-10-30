-- Run in Neon SQL Editor BEFORE deploying the game-unit correction.
-- Whole-kyat balances and all historical ledger amounts remain unchanged.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

alter table public.profiles
  add column if not exists balance_minor smallint not null default 0
  check (balance_minor between 0 and 99);

-- 1 = historical app-kyat arithmetic; 100 = corrected provider minor units.
alter table public.skm_wallet_transactions
  add column if not exists unit_scale smallint not null default 1
  check (unit_scale in (1, 100));

alter table public.wallet_wagering_events
  add column if not exists amount_scale smallint not null default 1
  check (amount_scale in (1, 100));

-- Do not reinterpret an unsettled hold accepted by the old unit handling.
-- If this fails, reconcile that hold before running the migration again.
do $$ begin
  if exists (select 1 from public.skm_wallet_transactions
              where kind = 'DEBIT' and status = 'APPLIED' and unit_scale = 1) then
    raise exception 'Unsettled legacy game debits exist; reconcile them before changing game units';
  end if;
  -- Prevent the pre-deployment code from accepting another unscaled debit
  -- after this migration commits. Its transaction will roll back completely.
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.skm_wallet_transactions'::regclass
                    and conname = 'skm_new_debits_minor_units') then
    alter table public.skm_wallet_transactions
      add constraint skm_new_debits_minor_units
      check (unit_scale = 100 or kind <> 'DEBIT' or status <> 'APPLIED');
  end if;
end $$;

commit;

select 'Game minor-unit storage is ready; existing balances were preserved' as result;
