-- Optional but recommended: use a restricted login for the running app.
-- Run as the Neon database owner AFTER migrations 001 through 010.
-- This creates a NEW role; it never changes the current owner's password.
-- Save the generated password from the SQL Editor NOTICE privately. Set
-- DATABASE_URL to this role in Vercel only after verifying the new connection.
-- A rerun preserves the existing role's password.

begin;

do $$
declare
  generated_password text;
begin
  if not exists (select 1 from pg_roles where rolname = 'j777_runtime') then
    generated_password := replace(gen_random_uuid()::text, '-', '')
                          || replace(gen_random_uuid()::text, '-', '');
    execute format('create role j777_runtime login nosuperuser nocreatedb nocreaterole noinherit password %L', generated_password);
    raise notice 'New j777_runtime password (save privately; do not commit or share): %', generated_password;
  elsif exists (
    select 1 from pg_roles
     where rolname = 'j777_runtime' and (rolsuper or rolcreatedb or rolcreaterole or rolbypassrls)
  ) or exists (
    select 1 from pg_auth_members m join pg_roles r on r.oid = m.member
     where r.rolname = 'j777_runtime'
  ) or exists (
    select 1 from pg_database d join pg_roles r on r.oid = d.datdba
     where r.rolname = 'j777_runtime'
  ) or exists (
    select 1 from pg_namespace n join pg_roles r on r.oid = n.nspowner
     where r.rolname = 'j777_runtime' and n.nspname = 'public'
  ) or exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      join pg_roles r on r.oid = c.relowner
     where r.rolname = 'j777_runtime' and n.nspname = 'public'
  ) or exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      join pg_roles r on r.oid = p.proowner
     where r.rolname = 'j777_runtime' and n.nspname = 'public'
  ) then
    raise exception 'Existing j777_runtime role has elevated attributes, memberships, or object ownership; review it before continuing';
  end if;
end $$;

revoke create on schema public from public;
revoke all on schema public from j777_runtime;
grant usage on schema public to j777_runtime;
revoke all on all tables in schema public from j777_runtime;
revoke all on all sequences in schema public from j777_runtime;

grant select, insert, update on public.profiles, public.auth_credentials,
  public.skm_game_sessions, public.skm_wallet_transactions,
  public.deposits, public.withdrawals, public.game_display_settings,
  public.wallet_wagering_events to j777_runtime;
grant select, insert, delete on public.auth_sessions, public.auth_admin_sessions to j777_runtime;
grant select, insert, update, delete on public.auth_rate_limits to j777_runtime;
grant select on public.slot_bets to j777_runtime;
grant usage on sequence public.wallet_wagering_events_id_seq to j777_runtime;

revoke all on public.profiles, public.auth_credentials, public.auth_sessions,
  public.auth_admin_sessions, public.auth_rate_limits, public.skm_game_sessions,
  public.skm_wallet_transactions, public.deposits, public.withdrawals,
  public.game_display_settings, public.wallet_wagering_events, public.slot_bets from public;

commit;

select rolname, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolbypassrls
  from pg_roles where rolname = 'j777_runtime';
