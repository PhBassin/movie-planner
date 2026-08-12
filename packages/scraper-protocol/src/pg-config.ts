// ---------------------------------------------------------------------------
// Shared PostgreSQL connection config for the bus's Postgres backends.
//
// Both the queue (PgJobQueue / PgJobConsumer) and the LISTEN/NOTIFY pub/sub
// (PostgresNotificationBus) connect to the same database, and each workspace
// duplicated the env-reading. `pgConnectionConfig` is the single source of
// that logic so the two roles can never drift: DATABASE_URL wins, otherwise
// the POSTGRES_* vars. Returns a plain object accepted by both pg.Pool and
// pg.Client. This is infra, not a domain concept — it exists to serve the bus
// port, and the per-workspace `db/client.ts` singletons keep their own config
// because they additionally require a password at startup.
// ---------------------------------------------------------------------------

export interface PgConnectionConfig {
  connectionString?: string;
  user?: string;
  password?: string;
  host?: string;
  port?: number;
  database?: string;
}

/** Strict port parse matching the repo's parseStrictInt guidance. */
function parsePort(value: string | undefined): number {
  if (value === undefined || value === null || value === '') return NaN;
  const strValue = String(value).trim();
  if (!/^\d+$/.test(strValue)) return NaN;
  const parsed = Number(strValue);
  return Number.isSafeInteger(parsed) ? parsed : NaN;
}

/** Build the connection config from the application environment. */
export function pgConnectionConfig(): PgConnectionConfig {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString) return { connectionString };
  return {
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD,
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parsePort(process.env.POSTGRES_PORT) || 5432,
    database: process.env.POSTGRES_DB || 'movie_planner',
  };
}
