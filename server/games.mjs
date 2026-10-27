import { getPool } from "./neon.mjs";

const GAME_COLUMNS = `id, provider_game_id as game_id, room_id, name, category, image_url,
  gradient_start, gradient_end, players_online, is_popular, is_active, sort_order`;

export async function listActiveGames() {
  const result = await getPool().query(
    `select ${GAME_COLUMNS} from public.games
      where is_active = true
      order by sort_order asc, id asc`,
  );
  return result.rows;
}

export async function getLaunchableGame(gameId, roomId) {
  const result = await getPool().query(
    `select provider_game_id as game_id, room_id
       from public.games
      where provider_game_id = $1 and room_id = $2 and is_active = true
      limit 1`,
    [gameId, roomId],
  );
  return result.rows[0] ?? null;
}
