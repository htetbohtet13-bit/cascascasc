import { displayedPlayerCount } from "./player-count.mjs";

export async function applyGameDisplaySettings(pool, providerGames, { includeHidden = false, randomInteger } = {}) {
  const sourceGames = Array.isArray(providerGames) ? providerGames : [];
  const gameCodes = sourceGames.map((game) => game.game_code).filter((code) => typeof code === "string");
  let settings = [];
  let settingsConfigured = true;

  if (gameCodes.length) {
    // Older schema versions can still serve fixed counts during deployment.
    const variants = ["players_online_max, is_hot", "players_online_max, false as is_hot",
      "null::integer as players_online_max, is_hot", "null::integer as players_online_max, false as is_hot"];
    for (const [index, columns] of variants.entries()) {
      try {
        const result = await pool.query(
          `select game_code, image_url, players_online, sort_order, is_active, ${columns}
           from public.game_display_settings
          where game_code = any($1::text[])`,
          [gameCodes],
        );
        settings = result.rows;
        break;
      } catch (error) {
        if (error?.code === "42P01") { settingsConfigured = false; break; }
        if (error?.code !== "42703" || index === variants.length - 1) throw error;
      }
    }
  }

  const settingsByCode = new Map(settings.map((setting) => [setting.game_code, setting]));
  const games = sourceGames.map((game, index) => {
    const setting = settingsByCode.get(game.game_code);
    return {
      ...game,
      image_url: setting ? setting.image_url : game.image_url ?? null,
      players_online: includeHidden ? setting?.players_online ?? null
        : displayedPlayerCount(setting?.players_online, setting?.players_online_max, randomInteger),
      ...(includeHidden ? { players_online_max: setting?.players_online_max ?? null } : {}),
      sort_order: setting?.sort_order ?? index + 1,
      is_active: setting?.is_active ?? true,
      is_hot: setting?.is_hot ?? false,
      _provider_order: index,
    };
  });

  const orderedGames = games
    .filter((game) => includeHidden || game.is_active)
    .sort((a, b) => a.sort_order - b.sort_order || a._provider_order - b._provider_order)
    .map(({ _provider_order, ...game }) => game);

  return { games: orderedGames, settingsConfigured };
}
