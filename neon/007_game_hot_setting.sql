-- Persist which provider games appear in the Hot category.
-- Run after 006_game_display_settings.sql in the Neon SQL Editor.

begin;

alter table public.game_display_settings
  add column if not exists is_hot boolean not null default false;

commit;

select game_code, is_hot
  from public.game_display_settings
 order by game_code;
