-- Shared bank availability for deposits and withdrawals. No balances or orders change.
begin;

create table if not exists public.deposit_bank_settings (
  service_type text primary key check (service_type in ('kbzpay', 'wavepay')),
  is_enabled boolean not null default true,
  updated_at timestamptz not null default clock_timestamp()
);

insert into public.deposit_bank_settings (service_type) values ('kbzpay'), ('wavepay')
on conflict (service_type) do nothing;

revoke all on public.deposit_bank_settings from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'j777_runtime') then
    revoke all on public.deposit_bank_settings from j777_runtime;
    grant select on public.deposit_bank_settings to j777_runtime;
    grant update (is_enabled, updated_at) on public.deposit_bank_settings to j777_runtime;
  end if;
end $$;

commit;
select 'Deposit bank switches are ready; existing balances and orders were preserved' as result;
