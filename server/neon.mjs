import pg from "pg";

const { Pool } = pg;

let pool;

export function normalizeDatabaseSslMode(connectionString) {
  let parsed;
  try {
    parsed = new URL(connectionString);
    if (!["postgres:", "postgresql:"].includes(parsed.protocol)) throw new Error("Invalid protocol");
  } catch {
    // URL parser errors can contain credentials; expose only a generic message.
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL");
  }
  // pg currently treats these aliases as verify-full, but warns that their
  // meaning will change. Preserve certificate AND hostname verification
  // explicitly, including when the URL contains duplicate sslmode parameters.
  const mode = parsed.searchParams.getAll("sslmode").at(-1);
  if (["prefer", "require", "verify-ca"].includes(mode)) {
    parsed.searchParams.set("sslmode", "verify-full");
    return parsed.toString();
  }
  return connectionString;
}

export function getPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not configured");
  }
  if (!pool) {
    pool = new Pool({
      connectionString: normalizeDatabaseSslMode(process.env.DATABASE_URL),
      max: Number(process.env.DATABASE_POOL_MAX || 3),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
  }
  return pool;
}

export async function withTransaction(callback) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
