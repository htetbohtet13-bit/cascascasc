-- Editable presentation settings for games returned by the live provider catalog.
-- Run once in the Neon SQL Editor before using admin game editing.

begin;

create table if not exists public.game_display_settings (
  game_code text primary key
    check (char_length(game_code) between 1 and 80 and game_code ~ '^[a-z0-9]+$'),
  image_url text
    check (image_url is null or (char_length(image_url) <= 2048 and image_url ~ '^https://')),
  players_online integer
    check (players_online is null or players_online between 0 and 1000000000),
  sort_order integer not null default 0
    check (sort_order between 0 and 1000000),
  is_active boolean not null default true,
  updated_at timestamptz not null default now()
);

create index if not exists game_display_settings_order_idx
  on public.game_display_settings (sort_order, game_code);

revoke all on public.game_display_settings from public;

commit;

select game_code, image_url, players_online, sort_order, is_active
  from public.game_display_settings
 order by sort_order, game_code;
