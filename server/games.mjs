import { getPool } from "./neon.mjs";

const GAME_COLUMNS = `id, provider_game_id as game_id, room_id, name, category, image_url,
  gradient_start, gradient_end, players_online, is_popular, is_active, sort_order`;

const LEGACY_BUFFALO = {
  id: "legacy-buffalo",
  game_id: 23,
  room_id: 1,
  name: "Charge Buffalo",
  category: "buffalo",
  image_url: "/images/buffalo.png",
  gradient_start: "#5c3918",
  gradient_end: "#d59612",
  players_online: null,
  is_popular: true,
  is_active: true,
  sort_order: 0,
};

export async function listActiveGames() {
  try {
    const result = await getPool().query(
      `select ${GAME_COLUMNS} from public.games
        where is_active = true
        order by sort_order asc, id asc`,
    );
    return result.rows;
  } catch (error) {
    if (error?.code === "42P01") return [LEGACY_BUFFALO];
    throw error;
  }
}

export async function getLaunchableGame(gameId, roomId) {
  try {
    const result = await getPool().query(
      `select provider_game_id as game_id, room_id
         from public.games
        where provider_game_id = $1 and room_id = $2 and is_active = true
        limit 1`,
      [gameId, roomId],
    );
    return result.rows[0] ?? null;
  } catch (error) {
    if (error?.code === "42P01" && gameId === 23 && roomId === 1) return { game_id: 23, room_id: 1 };
    throw error;
  }
}
