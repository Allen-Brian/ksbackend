import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import { PgClient } from "@effect/sql-pg";
import { Config, Duration, Layer } from "effect";

/**
 * Postgres connection pool as an Effect layer. Configured from the environment,
 * which varlock resolves + validates at the process edge; we read it here via
 * Effect `Config` (never `process.env`). The connection string stays `Redacted`
 * so it can't leak into logs.
 */
const PgLive = PgClient.layerConfig({
  url: Config.redacted("DATABASE_URL"),
  maxConnections: Config.integer("DB_POOL_MAX").pipe(Config.withDefault(10)),
  idleTimeout: Config.succeed(Duration.seconds(30)),
  applicationName: Config.succeed("kanasante-api"),
});

/**
 * The database layer.
 *
 * Provides both the low-level `SqlClient` — used for transactions via
 * `SqlClient.withTransaction` (NEVER Drizzle's `db.transaction()`, which throws
 * under the pg-proxy driver) — and the `PgDrizzle` query builder, which runs
 * through the same pooled connection. Repositories depend on `PgDrizzle` (and on
 * `SqlClient` when they own a transaction).
 */
export const DatabaseLive = PgDrizzle.layer.pipe(Layer.provideMerge(PgLive));
