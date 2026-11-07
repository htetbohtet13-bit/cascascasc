begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

alter table public.withdrawals
  add column if not exists approval_state text,
  add column if not exists approval_decided_at timestamptz,
  add column if not exists approval_admin_hash text;

do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.withdrawals'::regclass
    and conname = 'withdrawals_approval_consistency') then
    alter table public.withdrawals add constraint withdrawals_approval_consistency check (
      case approval_state
        when 'awaiting' then status = 'pending' and provider_txn_id is null and completed_at is null
          and approval_decided_at is null and approval_admin_hash is null
        when 'approved' then approval_decided_at is not null and approval_admin_hash is not null
        when 'declined' then status = 'failed' and provider_txn_id is null and completed_at is not null
          and approval_decided_at is not null and approval_admin_hash is not null
        else approval_state is null and approval_decided_at is null and approval_admin_hash is null
      end and (approval_admin_hash is null or approval_admin_hash ~ '^[0-9a-f]{64}$')
    );
  end if;
end $$;

commit;
select 'Withdrawal approval is ready' as result;
