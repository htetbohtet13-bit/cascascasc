-- Bulk import the supplied African Buffalo game list into the Neon catalog.
-- Game IDs and room IDs are preserved. The final `1` in the supplied rows is
-- treated as active; the games are also marked popular for the default filter.

begin;

insert into public.games
  (provider_game_id, room_id, name, category, image_url, is_popular, is_active, sort_order)
values
  (159, 1, 'Rising fortune', 'slots', 'https://buffalo-555.s3.ap-southeast-1.amazonaws.com/img/159.jpg', true, true, 1),
  (163, 1, 'Endless treasure', 'slots', 'https://buffalo-555.s3.ap-southeast-1.amazonaws.com/img/163.jpg', true, true, 2),
  (164, 1, 'PrancingPigs', 'slots', 'https://buffalo-555.s3.ap-southeast-1.amazonaws.com/img/164.jpg', true, true, 3),
  (165, 1, 'Ultimate Fire Link', 'slots', 'https://buffalo-555.s3.ap-southeast-1.amazonaws.com/img/165.jpg', true, true, 4),
  (169, 1, 'Imperial Seal', 'slots', 'https://buffalo-555.s3.ap-southeast-1.amazonaws.com/img/169.jpg', true, true, 5),
  (171, 1, 'GoldWithMoneyBall', 'slots', 'https://buffalo-555.s3.ap-southeast-1.amazonaws.com/img/171.jpg', true, true, 6),
  (137, 1, 'Panda Magic', 'slots', 'https://buffalo-555.s3.ap-southeast-1.amazonaws.com/img/137.jpg', true, true, 7),
  (140, 1, 'Eye of wealth', 'slots', 'https://buffalo-555.s3.ap-southeast-1.amazonaws.com/img/140.jpg', true, true, 8),
  (153, 1, 'Spring Festival', 'slots', 'https://buffalo-555.s3.ap-southeast-1.amazonaws.com/img/153.jpg', true, true, 9),
  (170, 1, 'ChangE', 'slots', 'https://buffalo-555.s3.ap-southeast-1.amazonaws.com/img/170.jpg', true, true, 10),
  (173, 1, 'Fortune Koi (KoiWealth)', 'slots', 'https://buffalo-555.s3.ap-southeast-1.amazonaws.com/img/173.jpg', true, true, 11),
  (195, 1, 'EmperorsPower', 'slots', 'https://buffalo-555.s3.ap-southeast-1.amazonaws.com/img/195.jpg', true, true, 12),
  (196, 1, 'Chinese temple', 'slots', 'https://buffalo-555.s3.ap-southeast-1.amazonaws.com/img/196.jpg', true, true, 13),
  (197, 1, 'Golden Buddha', 'slots', 'https://buffalo-555.s3.ap-southeast-1.amazonaws.com/img/197.jpg', true, true, 14),
  (198, 1, 'ChinaWild', 'slots', 'https://buffalo-555.s3.ap-southeast-1.amazonaws.com/img/198.jpg', true, true, 15),
  (175, 1, 'Koi Cash', 'slots', 'https://buffalo-555.s3.ap-southeast-1.amazonaws.com/img/175.jpg', true, true, 16),
  (129, 1, 'PriateFortune', 'slots', 'https://buffalo-555.s3.ap-southeast-1.amazonaws.com/img/129.jpg', true, true, 17),
  (130, 1, 'SinbadsVenlure', 'slots', 'https://buffalo-555.s3.ap-southeast-1.amazonaws.com/img/130.jpg', true, true, 18)
on conflict (provider_game_id, room_id) do update
  set name = excluded.name,
      category = excluded.category,
      image_url = excluded.image_url,
      is_popular = excluded.is_popular,
      is_active = excluded.is_active,
      sort_order = excluded.sort_order,
      updated_at = now();

commit;

select provider_game_id as game_id, room_id, name, is_popular, is_active
  from public.games
 where provider_game_id in (159, 163, 164, 165, 169, 171, 137, 140, 153, 170, 173, 195, 196, 197, 198, 175, 129, 130)
 order by sort_order, id;
