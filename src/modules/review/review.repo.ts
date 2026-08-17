import { SqlError } from "@effect/sql";
import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { practitionerProfile } from "@/db/schema/practitioner-profile";
import { profile } from "@/db/schema/profile";
import { review } from "@/db/schema/review";
import type { Review } from "@/domain/review/review";

type Row = typeof review.$inferSelect;

export type NewReviewRow = {
  readonly id: string;
  readonly practitionerProfileId: string;
  readonly reviewerUserId: string;
  readonly rating: number;
  readonly comment: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

const toDomain = (r: Row, reviewerName: string | null): Review => ({
  id: r.id,
  practitionerProfileId: r.practitionerProfileId,
  reviewerUserId: r.reviewerUserId,
  reviewerName,
  rating: r.rating,
  comment: r.comment,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

export interface ReviewRepoService {
  readonly findActiveByPair: (
    reviewerUserId: string,
    practitionerProfileId: string,
  ) => Effect.Effect<Review | undefined, SqlError.SqlError>;
  readonly insert: (row: NewReviewRow) => Effect.Effect<void, SqlError.SqlError>;
  readonly update: (
    id: string,
    patch: { readonly rating: number; readonly comment: string | null; readonly updatedAt: Date },
  ) => Effect.Effect<void, SqlError.SqlError>;
  readonly softDelete: (id: string, deletedAt: Date) => Effect.Effect<void, SqlError.SqlError>;
  readonly listByPractitioner: (
    practitionerProfileId: string,
    limit: number,
    beforeId: string | undefined,
  ) => Effect.Effect<ReadonlyArray<Review>, SqlError.SqlError>;
  /** Recompute the denormalized rating aggregate on practitioner_profile from active rows. */
  readonly recomputeRating: (
    practitionerProfileId: string,
    now: Date,
  ) => Effect.Effect<void, SqlError.SqlError>;
}

export class ReviewRepo extends Context.Tag("ReviewRepo")<ReviewRepo, ReviewRepoService>() {}

export const ReviewRepoLive = Layer.effect(
  ReviewRepo,
  Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;

    const joined = () =>
      db
        .select({ review, reviewerName: profile.givenNames })
        .from(review)
        .leftJoin(profile, eq(profile.userId, review.reviewerUserId));

    return {
      findActiveByPair: (reviewerUserId, practitionerProfileId) =>
        joined()
          .where(
            and(
              eq(review.reviewerUserId, reviewerUserId),
              eq(review.practitionerProfileId, practitionerProfileId),
              isNull(review.deletedAt),
            ),
          )
          .limit(1)
          .pipe(
            Effect.map((rows) =>
              rows[0] ? toDomain(rows[0].review, rows[0].reviewerName) : undefined,
            ),
          ),

      insert: (row) =>
        db
          .insert(review)
          .values({
            id: row.id,
            practitionerProfileId: row.practitionerProfileId,
            reviewerUserId: row.reviewerUserId,
            rating: row.rating,
            comment: row.comment,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          })
          .pipe(Effect.asVoid),

      update: (id, patch) =>
        db
          .update(review)
          .set({ rating: patch.rating, comment: patch.comment, updatedAt: patch.updatedAt })
          .where(eq(review.id, id))
          .pipe(Effect.asVoid),

      softDelete: (id, deletedAt) =>
        db.update(review).set({ deletedAt }).where(eq(review.id, id)).pipe(Effect.asVoid),

      listByPractitioner: (practitionerProfileId, limit, beforeId) =>
        joined()
          .where(
            and(
              eq(review.practitionerProfileId, practitionerProfileId),
              isNull(review.deletedAt),
              beforeId === undefined ? undefined : lt(review.id, beforeId),
            ),
          )
          .orderBy(desc(review.id))
          .limit(limit)
          .pipe(Effect.map((rows) => rows.map((r) => toDomain(r.review, r.reviewerName)))),

      recomputeRating: (practitionerProfileId, now) =>
        db
          .update(practitionerProfile)
          .set({
            ratingAverage: sql`coalesce((select round(avg(${review.rating})::numeric, 2) from ${review} where ${review.practitionerProfileId} = ${practitionerProfileId} and ${review.deletedAt} is null), 0)`,
            ratingCount: sql`(select count(*)::int from ${review} where ${review.practitionerProfileId} = ${practitionerProfileId} and ${review.deletedAt} is null)`,
            updatedAt: now,
          })
          .where(eq(practitionerProfile.id, practitionerProfileId))
          .pipe(Effect.asVoid),
    } satisfies ReviewRepoService;
  }),
);
