import { SqlError } from "@effect/sql";
import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { patientProfile } from "@/db/schema/patient-profile";
import { profile } from "@/db/schema/profile";
import type { Patient } from "@/domain/patient/patient";

type ProfileRow = typeof profile.$inferSelect;

const toDomain = (row: ProfileRow): Patient => ({
  id: row.id,
  userId: row.userId,
  surname: row.surname,
  givenNames: row.givenNames,
  phone: row.phone,
  dateOfBirth: row.dateOfBirth,
  sex: row.sex,
  consentAcceptedAt: row.consentAcceptedAt,
  consentVersion: row.consentVersion,
});

export interface PatientRepoService {
  /** The base profile of a user who holds a patient marker; undefined otherwise. */
  readonly findByUserId: (userId: string) => Effect.Effect<Patient | undefined, SqlError.SqlError>;
  /** Ensure the patient marker row exists (idempotent). */
  readonly ensure: (userId: string) => Effect.Effect<void, SqlError.SqlError>;
}

export class PatientRepo extends Context.Tag("PatientRepo")<PatientRepo, PatientRepoService>() {}

export const PatientRepoLive = Layer.effect(
  PatientRepo,
  Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;

    return {
      findByUserId: (userId) =>
        db
          .select({ profile })
          .from(patientProfile)
          .innerJoin(profile, eq(patientProfile.userId, profile.userId))
          .where(eq(patientProfile.userId, userId))
          .limit(1)
          .pipe(Effect.map((rows) => (rows[0] ? toDomain(rows[0].profile) : undefined))),

      ensure: (userId) =>
        db.insert(patientProfile).values({ userId }).onConflictDoNothing().pipe(Effect.asVoid),
    };
  }),
);
