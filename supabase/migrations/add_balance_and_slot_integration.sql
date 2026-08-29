alter table public.profiles
  add column if not exists balance bigint not null default 0,
  add column if not exists game_uid text;

update public.profiles
set game_uid = replace(id::text, '-', '')
where game_uid is null;

alter table public.profiles
  alter column game_uid set not null;

alter table public.profiles
  add constraint profiles_game_uid_key unique (game_uid);

alter table public.profiles
  add constraint profiles_game_uid_length
  check (char_length(game_uid) > 0 and char_length(game_uid) <= 50);

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, phone, balance, game_uid)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'phone', new.phone),
    0,
    replace(new.id::text, '-', '')
  );
  return new;
end;
$$;

create table public.game_tokens (
  uid text primary key references public.profiles (game_uid) on delete cascade,
  user_id uuid not null unique references public.profiles (id) on delete cascade,
  token text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz
);

alter table public.game_tokens enable row level security;
alter table public.game_tokens force row level security;
revoke all on table public.game_tokens from anon, authenticated;

create table public.slot_bets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  uid text not null,
  round_id text,
  bet_uid text not null unique,
  changemoney bigint not null,
  bet bigint not null,
  win bigint not null,
  room_id integer,
  game_id integer,
  balance_after bigint not null,
  created_at timestamptz not null default now()
);

create index slot_bets_user_created_idx
  on public.slot_bets (user_id, created_at desc);

alter table public.slot_bets enable row level security;
alter table public.slot_bets force row level security;

create policy "Users can read own slot bets"
  on public.slot_bets
  for select
  to authenticated
  using (user_id = (select auth.uid()));

grant select on table public.slot_bets to authenticated;
revoke insert, update, delete on table public.slot_bets from anon, authenticated;
revoke all on table public.slot_bets from anon;
revoke insert, update, delete on table public.profiles from anon, authenticated;
