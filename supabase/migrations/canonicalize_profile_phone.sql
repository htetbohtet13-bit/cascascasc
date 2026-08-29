create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, phone)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'phone', new.phone)
  );
  return new;
end;
$$;

alter table public.profiles
  drop constraint if exists profiles_phone_e164;

alter table public.profiles
  add constraint profiles_phone_e164
  check (phone ~ '^\+[1-9][0-9]{7,14}$');
