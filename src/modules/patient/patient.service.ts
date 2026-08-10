import { SqlClient, SqlError } from "@effect/sql";
import { Clock, Context, Effect, Layer } from "effect";
import type { Patient, PatientProfileInput } from "@/domain/patient/patient";
import { IdGenerator } from "@/infra/ids";
import { ProfileRepo } from "@/modules/profile/profile.repo";
import { PatientRepo } from "./patient.repo";

export interface PatientServiceService {
  readonly getProfile: (userId: string) => Effect.Effect<Patient | undefined, SqlError.SqlError>;
  readonly completeProfile: (
    userId: string,
    input: PatientProfileInput,
  ) => Effect.Effect<Patient, SqlError.SqlError>;
}

export class PatientService extends Context.Tag("PatientService")<
  PatientService,
  PatientServiceService
>() {}

export const PatientServiceLive = Layer.effect(
  PatientService,
  Effect.gen(function* () {
    const repo = yield* PatientRepo;
    const profiles = yield* ProfileRepo;
    const ids = yield* IdGenerator;
    const sql = yield* SqlClient.SqlClient;

    return {
      getProfile: (userId) => repo.findByUserId(userId),

      completeProfile: (userId, input) =>
        Effect.gen(function* () {
          const existing = yield* profiles.findByUserId(userId);
          const id = existing?.id ?? (yield* ids.next);
          const now = new Date(yield* Clock.currentTimeMillis);
          // Base profile + patient marker are one atomic unit.
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              const base = yield* profiles.upsert({
                id,
                userId,
                surname: input.surname,
                givenNames: input.givenNames,
                phone: input.phone ?? null,
                dateOfBirth: input.dateOfBirth,
                sex: input.sex,
                consentAcceptedAt: now,
                consentVersion: input.consentVersion,
              });
              yield* repo.ensure(userId);
              return base;
            }),
          );
        }),
    };
  }),
);
