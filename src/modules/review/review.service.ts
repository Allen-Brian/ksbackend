import { SqlClient, SqlError } from "@effect/sql";
import { Clock, Context, Effect, Layer } from "effect";
import type { Review, ReviewInput } from "@/domain/review/review";
import { Forbidden, NotFound, ValidationFailed } from "@/domain/shared/errors";
import { CurrentUser } from "@/infra/auth";
import { requireRole } from "@/infra/authz";
import { IdGenerator } from "@/infra/ids";
import { decodeCursor, encodeCursor } from "@/lib/cursor";
import { PractitionerRepo } from "@/modules/practitioner/practitioner.repo";
import { ReviewRepo } from "./review.repo";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ReviewPage = {
  readonly data: ReadonlyArray<Review>;
  readonly meta: {
    readonly count: number;
    readonly limit: number;
    readonly nextCursor: string | null;
    readonly hasNextPage: boolean;
  };
};

export interface ReviewServiceService {
  readonly upsertReview: (
    reviewerUserId: string,
    practitionerProfileId: string,
    input: ReviewInput,
  ) => Effect.Effect<
    { readonly review: Review; readonly created: boolean },
    Forbidden | NotFound | SqlError.SqlError,
    CurrentUser
  >;
  readonly deleteOwnReview: (
    reviewerUserId: string,
    practitionerProfileId: string,
  ) => Effect.Effect<void, NotFound | SqlError.SqlError>;
  readonly listReviews: (
    practitionerProfileId: string,
    limit: number,
    cursor: string | undefined,
  ) => Effect.Effect<ReviewPage, NotFound | ValidationFailed | SqlError.SqlError>;
}

export class ReviewService extends Context.Tag("ReviewService")<
  ReviewService,
  ReviewServiceService
>() {}

export const ReviewServiceLive = Layer.effect(
  ReviewService,
  Effect.gen(function* () {
    const repo = yield* ReviewRepo;
    const practitionerRepo = yield* PractitionerRepo;
    const ids = yield* IdGenerator;
    const sql = yield* SqlClient.SqlClient;

    // TODO(SCRUM-17): once booking exists, also require a completed appointment with
    // this practitioner before a patient can review them. For now the patient role gates it.
    const assertCanReview = requireRole("patient");

    // A review targets only a real, verified practitioner (unknown/unverified → 404,
    // matching the public-profile posture so ids aren't probed).
    const requireVerified = (practitionerProfileId: string) =>
      practitionerRepo
        .findById(practitionerProfileId)
        .pipe(
          Effect.flatMap((found) =>
            found === undefined || found.verificationStatus !== "verified"
              ? Effect.fail(new NotFound({ resource: "Practitioner", id: practitionerProfileId }))
              : Effect.void,
          ),
        );

    return {
      upsertReview: (reviewerUserId, practitionerProfileId, input) =>
        Effect.gen(function* () {
          yield* assertCanReview;
          yield* requireVerified(practitionerProfileId);
          const now = new Date(yield* Clock.currentTimeMillis);
          // upsert + recompute are one atomic unit so the aggregate never drifts.
          const created = yield* sql.withTransaction(
            Effect.gen(function* () {
              const existing = yield* repo.findActiveByPair(reviewerUserId, practitionerProfileId);
              if (existing === undefined) {
                const id = yield* ids.next;
                yield* repo.insert({
                  id,
                  practitionerProfileId,
                  reviewerUserId,
                  rating: input.rating,
                  comment: input.comment ?? null,
                  createdAt: now,
                  updatedAt: now,
                });
              } else {
                yield* repo.update(existing.id, {
                  rating: input.rating,
                  comment: input.comment ?? null,
                  updatedAt: now,
                });
              }
              yield* repo.recomputeRating(practitionerProfileId, now);
              return existing === undefined;
            }),
          );
          const review = yield* repo.findActiveByPair(reviewerUserId, practitionerProfileId);
          return {
            review: review ?? (yield* Effect.dieMessage("review missing after upsert")),
            created,
          };
        }),

      deleteOwnReview: (reviewerUserId, practitionerProfileId) =>
        Effect.gen(function* () {
          const now = new Date(yield* Clock.currentTimeMillis);
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const existing = yield* repo.findActiveByPair(reviewerUserId, practitionerProfileId);
              if (existing === undefined) {
                return yield* Effect.fail(new NotFound({ resource: "Review" }));
              }
              yield* repo.softDelete(existing.id, now);
              yield* repo.recomputeRating(practitionerProfileId, now);
            }),
          );
        }),

      listReviews: (practitionerProfileId, limit, cursor) =>
        Effect.gen(function* () {
          yield* requireVerified(practitionerProfileId);
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
          const rows = yield* repo.listByPractitioner(practitionerProfileId, limit + 1, beforeId);
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
    } satisfies ReviewServiceService;
  }),
);
