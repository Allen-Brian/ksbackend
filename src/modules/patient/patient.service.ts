import { SqlError } from "@effect/sql";
import { Clock, Context, Effect, Layer } from "effect";
import type { Patient, PatientProfileInput } from "@/domain/patient/patient";
import { IdGenerator } from "@/infra/ids";
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
    const ids = yield* IdGenerator;

    return {
      getProfile: (userId) => repo.findByUserId(userId),

      completeProfile: (userId, input) =>
        Effect.gen(function* () {
          const existing = yield* repo.findByUserId(userId);
          const id = existing?.id ?? (yield* ids.next);
          const now = new Date(yield* Clock.currentTimeMillis);
          return yield* repo.upsert({
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
        }),
    };
  }),
);
