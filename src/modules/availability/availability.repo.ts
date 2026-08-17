import { SqlError } from "@effect/sql";
import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import { and, desc, eq, gt, isNull, lt } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { availabilitySlot } from "@/db/schema/availability-slot";
import { practitionerProfile } from "@/db/schema/practitioner-profile";
import type { AvailabilitySlot } from "@/domain/availability/availability";

type Row = typeof availabilitySlot.$inferSelect;

export type NewSlotRow = {
  readonly id: string;
  readonly practitionerProfileId: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

const toDomain = (r: Row): AvailabilitySlot => ({
  id: r.id,
  practitionerProfileId: r.practitionerProfileId,
  startsAt: r.startsAt,
  endsAt: r.endsAt,
  status: r.status,
});

export interface AvailabilityRepoService {
  /** The practitioner_profile id owned by a user (undefined if they aren't a practitioner). */
  readonly practitionerIdForUser: (
    userId: string,
  ) => Effect.Effect<string | undefined, SqlError.SqlError>;
  /** Whether an active slot for this practitioner intersects [startsAt, endsAt). */
  readonly overlaps: (
    practitionerProfileId: string,
    startsAt: Date,
    endsAt: Date,
  ) => Effect.Effect<boolean, SqlError.SqlError>;
  readonly insert: (row: NewSlotRow) => Effect.Effect<AvailabilitySlot, SqlError.SqlError>;
  readonly listByPractitioner: (
    practitionerProfileId: string,
    limit: number,
    beforeId: string | undefined,
  ) => Effect.Effect<ReadonlyArray<AvailabilitySlot>, SqlError.SqlError>;
  /** Owner-scoped soft delete; resolves to whether a row was affected. */
  readonly softDelete: (
    practitionerProfileId: string,
    slotId: string,
    deletedAt: Date,
  ) => Effect.Effect<boolean, SqlError.SqlError>;
  /** The soonest open, future, non-deleted slot start (null if none). */
  readonly nextAvailableAt: (
    practitionerProfileId: string,
    now: Date,
  ) => Effect.Effect<Date | null, SqlError.SqlError>;
}

export class AvailabilityRepo extends Context.Tag("AvailabilityRepo")<
  AvailabilityRepo,
  AvailabilityRepoService
>() {}

export const AvailabilityRepoLive = Layer.effect(
  AvailabilityRepo,
  Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;

    return {
      practitionerIdForUser: (userId) =>
        db
          .select({ id: practitionerProfile.id })
          .from(practitionerProfile)
          .where(eq(practitionerProfile.userId, userId))
          .limit(1)
          .pipe(Effect.map((rows) => rows[0]?.id)),

      overlaps: (practitionerProfileId, startsAt, endsAt) =>
        db
          .select({ id: availabilitySlot.id })
          .from(availabilitySlot)
          .where(
            and(
              eq(availabilitySlot.practitionerProfileId, practitionerProfileId),
              isNull(availabilitySlot.deletedAt),
              // half-open interval intersection: existing.start < new.end AND existing.end > new.start
              lt(availabilitySlot.startsAt, endsAt),
              gt(availabilitySlot.endsAt, startsAt),
            ),
          )
          .limit(1)
          .pipe(Effect.map((rows) => rows.length > 0)),

      insert: (row) =>
        db
          .insert(availabilitySlot)
          .values({
            id: row.id,
            practitionerProfileId: row.practitionerProfileId,
            startsAt: row.startsAt,
            endsAt: row.endsAt,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          })
          .returning()
          .pipe(
            Effect.map((rows) => {
              const created = rows[0];
              return created === undefined
                ? {
                    id: row.id,
                    practitionerProfileId: row.practitionerProfileId,
                    startsAt: row.startsAt,
                    endsAt: row.endsAt,
                    status: "open" as const,
                  }
                : toDomain(created);
            }),
          ),

      listByPractitioner: (practitionerProfileId, limit, beforeId) =>
        db
          .select()
          .from(availabilitySlot)
          .where(
            and(
              eq(availabilitySlot.practitionerProfileId, practitionerProfileId),
              isNull(availabilitySlot.deletedAt),
              beforeId === undefined ? undefined : lt(availabilitySlot.id, beforeId),
            ),
          )
          .orderBy(desc(availabilitySlot.id))
          .limit(limit)
          .pipe(Effect.map((rows) => rows.map(toDomain))),

      softDelete: (practitionerProfileId, slotId, deletedAt) =>
        db
          .update(availabilitySlot)
          .set({ deletedAt, updatedAt: deletedAt })
          .where(
            and(
              eq(availabilitySlot.id, slotId),
              eq(availabilitySlot.practitionerProfileId, practitionerProfileId),
              isNull(availabilitySlot.deletedAt),
            ),
          )
          .returning({ id: availabilitySlot.id })
          .pipe(Effect.map((rows) => rows.length > 0)),

      // Keep the open/future/non-deleted rule in sync with the inline subquery in
      // practitioner search.repo.ts (nextAvailableExpr).
      nextAvailableAt: (practitionerProfileId, now) =>
        db
          .select({ startsAt: availabilitySlot.startsAt })
          .from(availabilitySlot)
          .where(
            and(
              eq(availabilitySlot.practitionerProfileId, practitionerProfileId),
              eq(availabilitySlot.status, "open"),
              isNull(availabilitySlot.deletedAt),
              gt(availabilitySlot.startsAt, now),
            ),
          )
          .orderBy(availabilitySlot.startsAt)
          .limit(1)
          .pipe(Effect.map((rows) => rows[0]?.startsAt ?? null)),
    } satisfies AvailabilityRepoService;
  }),
);
