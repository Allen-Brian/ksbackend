import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { isNull } from "drizzle-orm";
import { appointment } from "./db/schema/appointment";
import { Config, Effect, Redacted } from "effect";

// Release-step entry: apply the committed migrations in ./drizzle, then exit.
// Same journal + SQL files drizzle-kit produces (`bun run db:generate`); this
// only replaces the *applier* so the production image needs no drizzle-kit.
// Run via `bunx varlock run -- bun src/migrate.ts` (deploy/compose.yml `migrate`).
const databaseUrl = await Effect.runPromise(Config.redacted("DATABASE_URL"));

const db = drizzle(Redacted.value(databaseUrl));
await migrate(db, { migrationsFolder: "./drizzle" });
// Freeze the pre-existing application policy for legacy bookings before serving
// the new per-practitioner policy. Re-running this never changes a snapshot.
const cutoff = await Effect.runPromise(
  Config.integer("APPOINTMENT_CANCEL_CUTOFF_HOURS").pipe(Config.withDefault(0)),
);
await db
  .update(appointment)
  .set({ cancellationCutoffHours: cutoff })
  .where(isNull(appointment.cancellationCutoffHours));
await db.$client.end();
console.log("migrations applied");
