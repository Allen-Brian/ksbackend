import { SqlClient, SqlError } from "@effect/sql";
import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import { and, eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { pushSubscription } from "@/db/schema/push-subscription";
import type { PushSubscription } from "@/domain/push-subscription/push-subscription";

const toDomain = (row: typeof pushSubscription.$inferSelect): PushSubscription => ({
  id: row.id,
  userId: row.userId,
  endpoint: row.endpoint,
  keys: { p256dh: row.p256dh, auth: row.auth },
});
export interface PushSubscriptionRepoService {
  readonly lockRegistration: (userId: string) => Effect.Effect<void, SqlError.SqlError>;
  readonly findById: (id: string) => Effect.Effect<PushSubscription | undefined, SqlError.SqlError>;
  readonly findByUserId: (
    userId: string,
  ) => Effect.Effect<ReadonlyArray<PushSubscription>, SqlError.SqlError>;
  readonly upsert: (
    value: PushSubscription,
    now: Date,
  ) => Effect.Effect<PushSubscription | undefined, SqlError.SqlError>;
  readonly remove: (userId: string, id: string) => Effect.Effect<void, SqlError.SqlError>;
  readonly removeExpired: (
    subscription: PushSubscription,
  ) => Effect.Effect<void, SqlError.SqlError>;
}
export class PushSubscriptionRepo extends Context.Tag("PushSubscriptionRepo")<
  PushSubscriptionRepo,
  PushSubscriptionRepoService
>() {}
export const PushSubscriptionRepoLive = Layer.effect(
  PushSubscriptionRepo,
  Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;
    const sql = yield* SqlClient.SqlClient;
    return {
      lockRegistration: (userId) =>
        sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 2719))`.pipe(Effect.asVoid),
      findById: (id) =>
        db
          .select()
          .from(pushSubscription)
          .where(eq(pushSubscription.id, id))
          .limit(1)
          .pipe(Effect.map((rows) => (rows[0] === undefined ? undefined : toDomain(rows[0])))),
      findByUserId: (userId) =>
        db
          .select()
          .from(pushSubscription)
          .where(eq(pushSubscription.userId, userId))
          .pipe(Effect.map((rows) => rows.map(toDomain))),
      upsert: (value, now) =>
        db
          .insert(pushSubscription)
          .values({
            id: value.id,
            userId: value.userId,
            endpoint: value.endpoint,
            p256dh: value.keys.p256dh,
            auth: value.keys.auth,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: pushSubscription.endpoint,
            set: { p256dh: value.keys.p256dh, auth: value.keys.auth, updatedAt: now },
            setWhere: eq(pushSubscription.userId, value.userId),
          })
          .returning()
          .pipe(Effect.map((rows) => (rows[0] === undefined ? undefined : toDomain(rows[0])))),
      remove: (userId, id) =>
        db
          .delete(pushSubscription)
          .where(and(eq(pushSubscription.id, id), eq(pushSubscription.userId, userId)))
          .pipe(Effect.asVoid),
      removeExpired: (subscription) =>
        db
          .delete(pushSubscription)
          .where(
            and(
              eq(pushSubscription.id, subscription.id),
              eq(pushSubscription.userId, subscription.userId),
              eq(pushSubscription.endpoint, subscription.endpoint),
              eq(pushSubscription.p256dh, subscription.keys.p256dh),
              eq(pushSubscription.auth, subscription.keys.auth),
            ),
          )
          .pipe(Effect.asVoid),
    } satisfies PushSubscriptionRepoService;
  }),
);
