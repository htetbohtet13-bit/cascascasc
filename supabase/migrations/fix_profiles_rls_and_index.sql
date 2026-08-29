drop index if exists public.profiles_phone_idx;

drop policy if exists "Users can read own profile" on public.profiles;

create policy "Users can read own profile"
  on public.profiles
  for select
  to authenticated
  using (id = (select auth.uid()));
