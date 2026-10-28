-- Validate existing money without rounding or rewriting any ledger/balance.
-- If validation fails, inspect the affected rows and reconcile before retrying.
begin;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.profiles'::regclass and conname = 'profiles_balance_safe_integer') then
    alter table public.profiles add constraint profiles_balance_safe_integer check (balance between 0 and 9007199254740991) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.deposits'::regclass and conname = 'deposits_amount_safe_integer') then
    alter table public.deposits add constraint deposits_amount_safe_integer check (amount between 1 and 9007199254740991) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.withdrawals'::regclass and conname = 'withdrawals_amount_safe_integer') then
    alter table public.withdrawals add constraint withdrawals_amount_safe_integer check (amount between 1 and 9007199254740991) not valid;
  end if;
end $$;
alter table public.profiles validate constraint profiles_balance_safe_integer;
alter table public.deposits validate constraint deposits_amount_safe_integer;
alter table public.withdrawals validate constraint withdrawals_amount_safe_integer;
commit;
