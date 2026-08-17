import { SqlClient, SqlError } from "@effect/sql";
import { Clock, Context, Effect, Layer } from "effect";
import type { AvailabilitySlot, SlotInput } from "@/domain/availability/availability";
import { SlotOverlap } from "@/domain/availability/errors";
import { Forbidden, NotFound, ValidationFailed } from "@/domain/shared/errors";
import { CurrentUser } from "@/infra/auth";
import { requireAnyRole } from "@/infra/authz";
import { IdGenerator } from "@/infra/ids";
import { decodeCursor, encodeCursor } from "@/lib/cursor";
import { AvailabilityRepo } from "./availability.repo";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SlotPage = {
  readonly data: ReadonlyArray<AvailabilitySlot>;
  readonly meta: {
    readonly count: number;
    readonly limit: number;
    readonly nextCursor: string | null;
    readonly hasNextPage: boolean;
  };
};

export interface AvailabilityServiceService {
  readonly createSlot: (
    userId: string,
    input: SlotInput,
  ) => Effect.Effect<
    AvailabilitySlot,
    Forbidden | NotFound | ValidationFailed | SlotOverlap | SqlError.SqlError,
    CurrentUser
  >;
  readonly listMine: (
    userId: string,
    limit: number,
    cursor: string | undefined,
  ) => Effect.Effect<
    SlotPage,
    Forbidden | NotFound | ValidationFailed | SqlError.SqlError,
    CurrentUser
  >;
  readonly deleteSlot: (
    userId: string,
    slotId: string,
  ) => Effect.Effect<void, Forbidden | NotFound | SqlError.SqlError, CurrentUser>;
}

export class AvailabilityService extends Context.Tag("AvailabilityService")<
  AvailabilityService,
  AvailabilityServiceService
>() {}

export const AvailabilityServiceLive = Layer.effect(
  AvailabilityService,
  Effect.gen(function* () {
    const repo = yield* AvailabilityRepo;
    const ids = yield* IdGenerator;
    const sql = yield* SqlClient.SqlClient;

    const requirePractitioner = (userId: string) =>
      requireAnyRole("doctor", "nurse").pipe(
        Effect.zipRight(repo.practitionerIdForUser(userId)),
        Effect.flatMap((id) =>
          id === undefined
            ? Effect.fail(new NotFound({ resource: "Practitioner profile" }))
            : Effect.succeed(id),
        ),
      );

    return {
      createSlot: (userId, input) =>
        Effect.gen(function* () {
          const practitionerId = yield* requirePractitioner(userId);
          const now = new Date(yield* Clock.currentTimeMillis);
          if (input.endsAt.getTime() <= input.startsAt.getTime()) {
            return yield* Effect.fail(
              new ValidationFailed({
                issues: [{ path: "endsAt", message: "endsAt must be after startsAt." }],
              }),
            );
          }
          if (input.startsAt.getTime() <= now.getTime()) {
            return yield* Effect.fail(
              new ValidationFailed({
                issues: [{ path: "startsAt", message: "startsAt must be in the future." }],
              }),
            );
          }
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              const clash = yield* repo.overlaps(practitionerId, input.startsAt, input.endsAt);
              if (clash) {
                return yield* Effect.fail(new SlotOverlap({}));
              }
              const id = yield* ids.next;
              return yield* repo.insert({
                id,
                practitionerProfileId: practitionerId,
                startsAt: input.startsAt,
                endsAt: input.endsAt,
                createdAt: now,
                updatedAt: now,
              });
            }),
          );
        }),

      listMine: (userId, limit, cursor) =>
        Effect.gen(function* () {
          const practitionerId = yield* requirePractitioner(userId);
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
          const rows = yield* repo.listByPractitioner(practitionerId, limit + 1, beforeId);
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

      deleteSlot: (userId, slotId) =>
        Effect.gen(function* () {
          const practitionerId = yield* requirePractitioner(userId);
          const now = new Date(yield* Clock.currentTimeMillis);
          const deleted = yield* repo.softDelete(practitionerId, slotId, now);
          if (!deleted) return yield* Effect.fail(new NotFound({ resource: "Availability slot" }));
        }),
    } satisfies AvailabilityServiceService;
  }),
);
