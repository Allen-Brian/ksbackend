import { SqlError } from "@effect/sql";
import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { patientProfile } from "@/db/schema/patient-profile";
import type { Patient } from "@/domain/patient/patient";

type Row = typeof patientProfile.$inferSelect;
type Insert = typeof patientProfile.$inferInsert;

const toDomain = (row: Row): Patient => ({
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
  readonly findByUserId: (userId: string) => Effect.Effect<Patient | undefined, SqlError.SqlError>;
  readonly upsert: (values: Insert) => Effect.Effect<Patient, SqlError.SqlError>;
}

export class PatientRepo extends Context.Tag("PatientRepo")<PatientRepo, PatientRepoService>() {}

export const PatientRepoLive = Layer.effect(
  PatientRepo,
  Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;

    const firstOrDie = (rows: ReadonlyArray<Row>) =>
      rows[0] ? Effect.succeed(toDomain(rows[0])) : Effect.dieMessage("expected a patient row");

    return {
      findByUserId: (userId) =>
        db
          .select()
          .from(patientProfile)
          .where(eq(patientProfile.userId, userId))
          .limit(1)
          .pipe(Effect.map((rows) => (rows[0] ? toDomain(rows[0]) : undefined))),

      upsert: (values) =>
        db
          .insert(patientProfile)
          .values(values)
          .onConflictDoUpdate({
            target: patientProfile.userId,
            set: {
              surname: values.surname,
              givenNames: values.givenNames,
              phone: values.phone,
              dateOfBirth: values.dateOfBirth,
              sex: values.sex,
              updatedAt: new Date(values.consentAcceptedAt),
            },
          })
          .returning()
          .pipe(Effect.flatMap(firstOrDie)),
    };
  }),
);
