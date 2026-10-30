-- Run with the database owner's role before deploying the bonus update.
-- The updated app records the promotion launch time on its first bonus lookup.
-- Preparing storage ahead of deployment therefore does not launch the offer.
-- This does not change balances,
-- award historical bonuses, or reset anyone's existing wagering requirement.
begin;
set local lock_timeout = '5s';

create table if not exists public.deposit_bonus_campaign (
  singleton boolean primary key default true check (singleton),
  starts_at timestamptz not null default clock_timestamp()
);

alter table public.deposits
  add column if not exists bonus_amount bigint not null default 0;
alter table public.wallet_wagering_events
  add column if not exists wagering_multiplier smallint not null default 1;

do $$
begin
  if not exists (select 1 from pg_constraint
    where conrelid = 'public.deposits'::regclass and conname = 'deposits_bonus_rules') then
    alter table public.deposits add constraint deposits_bonus_rules check (
      bonus_amount = 0 or
      (bonus_amount = 5000 and amount >= 5000 and status = 'verified'
       and amount <= 9007199254735991)
    );
  end if;
  if not exists (select 1 from pg_constraint
    where conrelid = 'public.wallet_wagering_events'::regclass and conname = 'wagering_multiplier_rules') then
    alter table public.wallet_wagering_events add constraint wagering_multiplier_rules check (
      wagering_multiplier = 1 or
      (wagering_multiplier = 30 and kind = 'DEPOSIT' and amount_scale = 1)
    );
  end if;
end $$;

-- The deposit is the permanent claim record, including after a zero-balance reset.
create unique index if not exists deposits_one_bonus_per_user_idx
  on public.deposits (user_id) where bonus_amount > 0;
create index if not exists deposits_verified_user_completed_idx
  on public.deposits (user_id, (coalesce(completed_at, created_at)))
  where status = 'verified';

revoke all on public.deposit_bonus_campaign from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'j777_runtime') then
    grant select, insert on public.deposit_bonus_campaign to j777_runtime;
  end if;
end $$;

commit;
select 'First-deposit bonus storage is ready; existing balances were preserved' as result,
       (select starts_at from public.deposit_bonus_campaign) as bonus_launch_time;
