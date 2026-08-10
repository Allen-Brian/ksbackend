import { Layer, ManagedRuntime } from "effect";
import { CryptoLive } from "./infra/crypto";
import { DatabaseLive } from "./infra/db";
import { EmailSender, EmailSenderConsoleLive, EmailSenderResendLive } from "./infra/email";
import { HealthLive } from "./infra/health";
import { IdGeneratorLive } from "./infra/ids";
import { LoggerLive } from "./infra/logger";
import { RateLimiterInMemoryLive } from "./infra/rate-limiter";
import { FileScanner, FileScannerCleanLive, FileScannerS3Live } from "./infra/scanner";
import { FileStorage, FileStorageFakeLive, FileStorageS3Live } from "./infra/storage";
import { AdminServiceLive } from "./modules/admin/admin.service";
import { DependentRepoLive } from "./modules/dependent/dependent.repo";
import { DependentServiceLive } from "./modules/dependent/dependent.service";
import { NotificationRepoLive } from "./modules/notification/notification.repo";
import { NotificationServiceLive } from "./modules/notification/notification.service";
import { PatientRepoLive } from "./modules/patient/patient.repo";
import { PatientServiceLive } from "./modules/patient/patient.service";
import { ProfileRepoLive } from "./modules/profile/profile.repo";
import { ProfileServiceLive } from "./modules/profile/profile.service";
import { PractitionerRepoLive } from "./modules/practitioner/practitioner.repo";
import { PractitionerServiceLive } from "./modules/practitioner/practitioner.service";

/** Swappable external infra. Real drivers when serving; fakes only under test. */
export type InfraLayers = {
  readonly email: Layer.Layer<EmailSender, unknown, never>;
  readonly storage: Layer.Layer<FileStorage, unknown, never>;
  readonly scanner: Layer.Layer<FileScanner, unknown, never>;
};

/**
 * In-memory fakes — for automated tests ONLY (the API harness builds its own).
 * Not used by any running server: local dev talks to real S3/Resend (LocalStack
 * + a personal Resend account), so the code path matches production exactly.
 */
export const fakeInfra: InfraLayers = {
  email: EmailSenderConsoleLive,
  storage: FileStorageFakeLive,
  scanner: FileScannerCleanLive,
};

/**
 * Assemble the full application layer over a given database layer + infra choice.
 * This is the SINGLE place the layer graph is wired (docs/conventions.md).
 */
export const makeAppLayer = (database: typeof DatabaseLive, infra: InfraLayers) => {
  const idGen = IdGeneratorLive;
  const crypto = CryptoLive;

  const profileRepo = ProfileRepoLive.pipe(Layer.provide(database));
  const patientRepo = PatientRepoLive.pipe(Layer.provide(database));
  const practitionerRepo = PractitionerRepoLive.pipe(Layer.provide(database));
  const dependentRepo = DependentRepoLive.pipe(Layer.provide(database));
  const notificationRepo = NotificationRepoLive.pipe(Layer.provide(database));

  const profile = ProfileServiceLive.pipe(
    Layer.provide(Layer.mergeAll(profileRepo, idGen, infra.storage)),
  );
  const notification = NotificationServiceLive.pipe(
    Layer.provide(Layer.mergeAll(notificationRepo, idGen)),
  );
  // `database` is also given to services that run multi-write transactions
  // (SqlClient.withTransaction) — the repos + service then share one SqlClient.
  const patient = PatientServiceLive.pipe(
    Layer.provide(Layer.mergeAll(patientRepo, profileRepo, idGen, database)),
  );
  const practitioner = PractitionerServiceLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        practitionerRepo,
        profileRepo,
        idGen,
        crypto,
        infra.scanner,
        infra.storage,
        database,
      ),
    ),
  );
  const admin = AdminServiceLive.pipe(
    Layer.provide(
      Layer.mergeAll(practitionerRepo, idGen, crypto, infra.storage, infra.email, database),
    ),
  );
  const dependent = DependentServiceLive.pipe(Layer.provide(Layer.mergeAll(dependentRepo, idGen)));
  const health = HealthLive.pipe(Layer.provide(database));

  return Layer.mergeAll(
    profile,
    notification,
    patient,
    practitioner,
    admin,
    dependent,
    health,
    RateLimiterInMemoryLive,
    LoggerLive,
  );
};

/**
 * Infra for a running server. Storage (S3) and email (Resend) are the SAME real
 * drivers in every environment — local just points them at LocalStack and a
 * personal Resend account via env (AWS_ENDPOINT_URL_S3 / RESEND_API_KEY). Only
 * the malware scanner differs: GuardDuty runs in deployed environments, but it
 * can't be emulated by LocalStack, so local falls back to the clean scanner.
 */
export const infraFor = (appEnv: string): InfraLayers => ({
  email: EmailSenderResendLive,
  storage: FileStorageS3Live,
  scanner: appEnv === "prod" || appEnv === "staging" ? FileScannerS3Live : FileScannerCleanLive,
});

/** Build the one application runtime (production entry). */
export const makeRuntime = (appEnv: string) =>
  ManagedRuntime.make(makeAppLayer(DatabaseLive, infraFor(appEnv)));
