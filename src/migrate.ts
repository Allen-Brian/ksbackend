import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { Config, Effect, Redacted } from "effect";

// Release-step entry: apply the committed migrations in ./drizzle, then exit.
// Same journal + SQL files drizzle-kit produces (`bun run db:generate`); this
// only replaces the *applier* so the production image needs no drizzle-kit.
// Run via `bunx varlock run -- bun src/migrate.ts` (deploy/compose.yml `migrate`).
const databaseUrl = await Effect.runPromise(Config.redacted("DATABASE_URL"));

const db = drizzle(Redacted.value(databaseUrl));
await migrate(db, { migrationsFolder: "./drizzle" });
await db.$client.end();
console.log("migrations applied");
