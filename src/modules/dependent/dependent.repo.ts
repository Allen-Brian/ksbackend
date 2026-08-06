import { SqlError } from "@effect/sql";
import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import { and, desc, eq, isNull, lt } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { dependent } from "@/db/schema/dependent";
import type { Dependent, DependentPatch } from "@/domain/dependent/dependent";

type Row = typeof dependent.$inferSelect;
type Insert = typeof dependent.$inferInsert;

const toDomain = (row: Row): Dependent => ({
  id: row.id,
  accountHolderUserId: row.accountHolderUserId,
  surname: row.surname,
  givenNames: row.givenNames,
  dateOfBirth: row.dateOfBirth,
  sex: row.sex,
  relationship: row.relationship,
  phone: row.phone,
  location: row.location,
});

export interface DependentRepoService {
  readonly create: (values: Insert) => Effect.Effect<Dependent, SqlError.SqlError>;
  readonly listByOwner: (
    ownerId: string,
    limit: number,
    beforeId: string | undefined,
  ) => Effect.Effect<ReadonlyArray<Dependent>, SqlError.SqlError>;
  readonly findForOwner: (
    ownerId: string,
    id: string,
  ) => Effect.Effect<Dependent | undefined, SqlError.SqlError>;
  readonly update: (
    ownerId: string,
    id: string,
    patch: DependentPatch,
  ) => Effect.Effect<Dependent | undefined, SqlError.SqlError>;
  readonly softDelete: (
    ownerId: string,
    id: string,
    deletedAt: Date,
  ) => Effect.Effect<boolean, SqlError.SqlError>;
}

export class DependentRepo extends Context.Tag("DependentRepo")<
  DependentRepo,
  DependentRepoService
>() {}

const activeAndOwned = (ownerId: string, id: string) =>
  and(
    eq(dependent.id, id),
    eq(dependent.accountHolderUserId, ownerId),
    isNull(dependent.deletedAt),
  );

export const DependentRepoLive = Layer.effect(
  DependentRepo,
  Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;

    return {
      create: (values) =>
        db
          .insert(dependent)
          .values(values)
          .returning()
          .pipe(
            Effect.flatMap((rows) =>
              rows[0]
                ? Effect.succeed(toDomain(rows[0]))
                : Effect.dieMessage("insert returned no row"),
            ),
          ),

      listByOwner: (ownerId, limit, beforeId) =>
        db
          .select()
          .from(dependent)
          .where(
            beforeId === undefined
              ? and(eq(dependent.accountHolderUserId, ownerId), isNull(dependent.deletedAt))
              : and(
                  eq(dependent.accountHolderUserId, ownerId),
                  isNull(dependent.deletedAt),
                  lt(dependent.id, beforeId),
                ),
          )
          .orderBy(desc(dependent.id))
          .limit(limit)
          .pipe(Effect.map((rows) => rows.map(toDomain))),

      findForOwner: (ownerId, id) =>
        db
          .select()
          .from(dependent)
          .where(activeAndOwned(ownerId, id))
          .limit(1)
          .pipe(Effect.map((rows) => (rows[0] ? toDomain(rows[0]) : undefined))),

      update: (ownerId, id, patch) =>
        db
          .update(dependent)
          // Only set fields that were actually provided (exactOptionalPropertyTypes).
          .set({
            ...(patch.surname !== undefined && { surname: patch.surname }),
            ...(patch.givenNames !== undefined && { givenNames: patch.givenNames }),
            ...(patch.dateOfBirth !== undefined && { dateOfBirth: patch.dateOfBirth }),
            ...(patch.sex !== undefined && { sex: patch.sex }),
            ...(patch.relationship !== undefined && { relationship: patch.relationship }),
            ...(patch.phone !== undefined && { phone: patch.phone }),
            ...(patch.location !== undefined && { location: patch.location }),
          })
          .where(activeAndOwned(ownerId, id))
          .returning()
          .pipe(Effect.map((rows) => (rows[0] ? toDomain(rows[0]) : undefined))),

      softDelete: (ownerId, id, deletedAt) =>
        db
          .update(dependent)
          .set({ deletedAt })
          .where(activeAndOwned(ownerId, id))
          .returning({ id: dependent.id })
          .pipe(Effect.map((rows) => rows.length > 0)),
    } satisfies DependentRepoService;
  }),
);
