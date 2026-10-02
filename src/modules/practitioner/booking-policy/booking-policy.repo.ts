import { SqlError } from "@effect/sql";
import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import { and, eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { practitionerProfile } from "@/db/schema/practitioner-profile";

type PolicyRow = { readonly cutoff: number | null };
export class BookingPolicyRepo extends Context.Tag("BookingPolicyRepo")<
  BookingPolicyRepo,
  {
    readonly findPublic: (id: string) => Effect.Effect<PolicyRow | undefined, SqlError.SqlError>;
    readonly findForUser: (
      userId: string,
    ) => Effect.Effect<PolicyRow | undefined, SqlError.SqlError>;
    readonly updateForUser: (
      userId: string,
      cutoff: number | null,
      now: Date,
    ) => Effect.Effect<PolicyRow | undefined, SqlError.SqlError>;
  }
>() {}
export const BookingPolicyRepoLive = Layer.effect(
  BookingPolicyRepo,
  Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;
    return {
      findPublic: (id) =>
        db
          .select({ cutoff: practitionerProfile.cancellationCutoffHours })
          .from(practitionerProfile)
          .where(
            and(
              eq(practitionerProfile.id, id),
              eq(practitionerProfile.verificationStatus, "verified"),
            ),
          )
          .limit(1)
          .pipe(Effect.map((rows) => rows[0])),
      findForUser: (userId) =>
        db
          .select({ cutoff: practitionerProfile.cancellationCutoffHours })
          .from(practitionerProfile)
          .where(eq(practitionerProfile.userId, userId))
          .limit(1)
          .pipe(Effect.map((rows) => rows[0])),
      updateForUser: (userId, cutoff, now) =>
        db
          .update(practitionerProfile)
          .set({ cancellationCutoffHours: cutoff, updatedAt: now })
          .where(eq(practitionerProfile.userId, userId))
          .returning({ cutoff: practitionerProfile.cancellationCutoffHours })
          .pipe(Effect.map((rows) => rows[0])),
    };
  }),
);
