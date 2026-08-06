import { SqlError } from "@effect/sql";
import { Clock, Context, Effect, Layer } from "effect";
import type { Dependent, DependentInput, DependentPatch } from "@/domain/dependent/dependent";
import { NotFound, ValidationFailed } from "@/domain/shared/errors";
import { IdGenerator } from "@/infra/ids";
import { decodeCursor, encodeCursor } from "@/lib/cursor";
import { DependentRepo } from "./dependent.repo";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DependentPage = {
  readonly data: ReadonlyArray<Dependent>;
  readonly meta: {
    readonly count: number;
    readonly limit: number;
    readonly nextCursor: string | null;
    readonly hasNextPage: boolean;
  };
};

export interface DependentServiceService {
  readonly create: (
    ownerId: string,
    input: DependentInput,
  ) => Effect.Effect<Dependent, SqlError.SqlError>;
  readonly list: (
    ownerId: string,
    limit: number,
    cursor: string | undefined,
  ) => Effect.Effect<DependentPage, ValidationFailed | SqlError.SqlError>;
  readonly get: (
    ownerId: string,
    id: string,
  ) => Effect.Effect<Dependent, NotFound | SqlError.SqlError>;
  readonly update: (
    ownerId: string,
    id: string,
    patch: DependentPatch,
  ) => Effect.Effect<Dependent, NotFound | SqlError.SqlError>;
  readonly remove: (
    ownerId: string,
    id: string,
  ) => Effect.Effect<void, NotFound | SqlError.SqlError>;
}

export class DependentService extends Context.Tag("DependentService")<
  DependentService,
  DependentServiceService
>() {}

export const DependentServiceLive = Layer.effect(
  DependentService,
  Effect.gen(function* () {
    const repo = yield* DependentRepo;
    const ids = yield* IdGenerator;

    return {
      create: (ownerId, input) =>
        Effect.gen(function* () {
          const id = yield* ids.next;
          return yield* repo.create({
            id,
            accountHolderUserId: ownerId,
            surname: input.surname,
            givenNames: input.givenNames,
            dateOfBirth: input.dateOfBirth,
            sex: input.sex,
            relationship: input.relationship,
            phone: input.phone ?? null,
            location: input.location ?? null,
          });
        }),

      list: (ownerId, limit, cursor) =>
        Effect.gen(function* () {
          let beforeId: string | undefined;
          if (cursor !== undefined) {
            const decoded = decodeCursor(cursor);
            if (!UUID_RE.test(decoded)) {
              return yield* Effect.fail(
                new ValidationFailed({ issues: [{ path: "cursor", message: "Invalid cursor." }] }),
              );
            }
            beforeId = decoded;
          }
          const rows = yield* repo.listByOwner(ownerId, limit + 1, beforeId);
          const hasNextPage = rows.length > limit;
          const data = hasNextPage ? rows.slice(0, limit) : rows;
          const last = data.at(-1);
          return {
            data,
            meta: {
              count: data.length,
              limit,
              nextCursor: hasNextPage && last ? encodeCursor(last.id) : null,
              hasNextPage,
            },
          };
        }),

      get: (ownerId, id) =>
        repo
          .findForOwner(ownerId, id)
          .pipe(
            Effect.flatMap((found) =>
              found === undefined
                ? Effect.fail(new NotFound({ resource: "Dependent", id }))
                : Effect.succeed(found),
            ),
          ),

      update: (ownerId, id, patch) =>
        repo
          .update(ownerId, id, patch)
          .pipe(
            Effect.flatMap((updated) =>
              updated === undefined
                ? Effect.fail(new NotFound({ resource: "Dependent", id }))
                : Effect.succeed(updated),
            ),
          ),

      remove: (ownerId, id) =>
        Effect.gen(function* () {
          const now = new Date(yield* Clock.currentTimeMillis);
          const deleted = yield* repo.softDelete(ownerId, id, now);
          if (!deleted) {
            return yield* Effect.fail(new NotFound({ resource: "Dependent", id }));
          }
        }),
    } satisfies DependentServiceService;
  }),
);
