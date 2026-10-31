-- Adds an optional upper bound. Existing fixed player counts stay unchanged.
begin;
set local lock_timeout = '5s';
alter table public.game_display_settings
  add column if not exists players_online_max integer;
do $$ begin
  if not exists (select 1 from pg_constraint
    where conrelid = 'public.game_display_settings'::regclass
      and conname = 'game_players_range_valid') then
    alter table public.game_display_settings add constraint game_players_range_valid
      check (players_online_max is null or
        (players_online is not null and players_online_max >= players_online
         and players_online_max <= 1000000000));
  end if;
end $$;
commit;
select 'Game player ranges are ready; existing counts were preserved' as result;
