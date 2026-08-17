import { SqlClient, SqlError } from "@effect/sql";
import { Clock, Context, Effect, Layer } from "effect";
import type {
  CredentialSubmission,
  Practitioner,
  PractitionerRegistration,
  PublicProfilePatch,
} from "@/domain/practitioner/practitioner";
import {
  FileInfected,
  LicenceAlreadyRegistered,
  NotFound,
  ProfileIncomplete,
  ValidationFailed,
  VerificationStateInvalid,
} from "@/domain/shared/errors";
import { Crypto } from "@/infra/crypto";
import { Geocoder } from "@/infra/geocoding";
import { IdGenerator } from "@/infra/ids";
import { FileScanner } from "@/infra/scanner";
import { FileStorage, type PresignedUpload, type StorageError } from "@/infra/storage";
import { AvailabilityRepo } from "@/modules/availability/availability.repo";
import { ProfileRepo } from "@/modules/profile/profile.repo";
import { PractitionerRepo } from "./practitioner.repo";

type DocumentKind = "cmc-certificate" | "nic" | "profile-photo";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const DOC_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];
const ALLOWED_CONTENT_TYPES = {
  "cmc-certificate": DOC_TYPES,
  nic: DOC_TYPES,
  "profile-photo": ["image/jpeg", "image/png"],
} satisfies Record<DocumentKind, ReadonlyArray<string>>;
const KEY_PREFIX = {
  "cmc-certificate": "practitioner-documents",
  nic: "practitioner-documents",
  "profile-photo": "profile-photos",
} satisfies Record<DocumentKind, string>;

export interface PractitionerServiceService {
  readonly register: (
    userId: string,
    role: "doctor" | "nurse",
    input: PractitionerRegistration,
  ) => Effect.Effect<Practitioner, SqlError.SqlError>;
  readonly presignDocument: (
    userId: string,
    kind: DocumentKind,
    contentType: string,
  ) => Effect.Effect<PresignedUpload, ValidationFailed | StorageError>;
  readonly submitCredentials: (
    userId: string,
    input: CredentialSubmission,
  ) => Effect.Effect<
    Practitioner,
    | ProfileIncomplete
    | VerificationStateInvalid
    | FileInfected
    | LicenceAlreadyRegistered
    | SqlError.SqlError
  >;
  readonly getMine: (userId: string) => Effect.Effect<Practitioner, NotFound | SqlError.SqlError>;
  readonly updatePublicProfile: (
    userId: string,
    patch: PublicProfilePatch,
  ) => Effect.Effect<Practitioner, NotFound | SqlError.SqlError>;
  /** A verified practitioner's public profile + presigned photo + next open slot, for patients. */
  readonly getPublic: (id: string) => Effect.Effect<
    {
      readonly practitioner: Practitioner;
      readonly photoUrl: string | null;
      readonly nextAvailableAt: Date | null;
    },
    NotFound | StorageError | SqlError.SqlError
  >;
}

export class PractitionerService extends Context.Tag("PractitionerService")<
  PractitionerService,
  PractitionerServiceService
>() {}

export const PractitionerServiceLive = Layer.effect(
  PractitionerService,
  Effect.gen(function* () {
    const repo = yield* PractitionerRepo;
    const profiles = yield* ProfileRepo;
    const availability = yield* AvailabilityRepo;
    const geocoder = yield* Geocoder;
    const ids = yield* IdGenerator;
    const crypto = yield* Crypto;
    const scanner = yield* FileScanner;
    const storage = yield* FileStorage;
    const sql = yield* SqlClient.SqlClient;

    // Best-effort: geocode the location to coordinates for distance search. Runs after the
    // profile write commits and is awaited inline (not forked); a failed lookup (unknown place
    // or provider hiccup) logs and leaves coords unset — it must never fail the write itself
    // (mirrors the admin email-notify pattern).
    const geocodeAndStore = (userId: string, location: string | null | undefined) =>
      location === null || location === undefined || location.trim() === ""
        ? Effect.void
        : geocoder.geocode(location).pipe(
            Effect.flatMap((coords) =>
              coords === null
                ? Effect.void
                : Effect.flatMap(Clock.currentTimeMillis, (ms) =>
                    repo.setCoordinates(userId, coords, new Date(ms)),
                  ),
            ),
            Effect.catchAll((cause) =>
              Effect.logWarning("geocode failed; coordinates left unchanged", cause),
            ),
          );

    return {
      register: (userId, role, input) =>
        Effect.gen(function* () {
          const existingProfile = yield* profiles.findByUserId(userId);
          const profileId = existingProfile?.id ?? (yield* ids.next);
          const practitionerId = yield* ids.next;
          const now = new Date(yield* Clock.currentTimeMillis);
          // Base profile + professional row + role grant are one atomic unit.
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* profiles.upsert({
                id: profileId,
                userId,
                surname: input.surname,
                givenNames: input.givenNames,
                phone: input.phone ?? null,
                dateOfBirth: input.dateOfBirth ?? null,
                sex: input.sex ?? null,
                consentAcceptedAt: now,
                consentVersion: input.consentVersion,
              });
              yield* repo.create({
                id: practitionerId,
                userId,
                professionId: input.professionId,
                prefix: input.prefix ?? null,
                location: input.location ?? null,
                verificationStatus: "incomplete",
              });
              yield* repo.grantRole(userId, role);
            }),
          );
          const created = yield* repo.findByUserId(userId);
          yield* geocodeAndStore(userId, input.location);
          return created ?? (yield* Effect.dieMessage("practitioner missing after create"));
        }),

      presignDocument: (userId, kind, contentType) =>
        Effect.gen(function* () {
          if (!ALLOWED_CONTENT_TYPES[kind].includes(contentType)) {
            return yield* Effect.fail(
              new ValidationFailed({
                issues: [{ path: "contentType", message: "Unsupported content type." }],
              }),
            );
          }
          const uuid = yield* ids.next;
          return yield* storage.presignUpload({
            key: `${KEY_PREFIX[kind]}/${userId}/${uuid}`,
            contentType,
            maxBytes: MAX_UPLOAD_BYTES,
          });
        }),

      submitCredentials: (userId, input) =>
        Effect.gen(function* () {
          const existing = yield* repo.findByUserId(userId);
          if (existing === undefined) {
            return yield* Effect.fail(new ProfileIncomplete({ resource: "Practitioner" }));
          }
          // Resubmission is for incomplete/rejected (and idempotently pending)
          // profiles; a verified practitioner can't silently reset themselves to
          // pending and swap their already-approved credentials.
          if (existing.verificationStatus === "verified") {
            return yield* Effect.fail(
              new VerificationStateInvalid({ current: existing.verificationStatus }),
            );
          }
          const keys = [input.cmcCertificateFileKey, input.nicFileKey, input.profilePhotoFileKey];
          yield* Effect.forEach(
            keys,
            (key) =>
              scanner
                .status(key)
                .pipe(
                  Effect.flatMap((status) =>
                    status === "infected" ? Effect.fail(new FileInfected({ key })) : Effect.void,
                  ),
                ),
            { concurrency: "unbounded", discard: true },
          );
          const cmcHmac = crypto.hmac(input.cmcRegistrationNumber);
          const nicHmac = crypto.hmac(input.nicNumber);
          const conflict = yield* repo.hasConflictingHmac(userId, cmcHmac, nicHmac);
          if (conflict) {
            return yield* Effect.fail(new LicenceAlreadyRegistered({ field: "cmc/nic" }));
          }
          const cmcNumberEncrypted = yield* crypto.encrypt(input.cmcRegistrationNumber);
          const nicNumberEncrypted = yield* crypto.encrypt(input.nicNumber);
          const now = new Date(yield* Clock.currentTimeMillis);
          const updated = yield* repo.applyCredentials(userId, {
            cmcNumberEncrypted,
            cmcNumberHmac: cmcHmac,
            nicNumberEncrypted,
            nicNumberHmac: nicHmac,
            cmcCertificateFileKey: input.cmcCertificateFileKey,
            nicFileKey: input.nicFileKey,
            profilePhotoFileKey: input.profilePhotoFileKey,
            verificationStatus: "pending_verification",
            updatedAt: now,
          });
          return updated === undefined
            ? yield* Effect.fail(new ProfileIncomplete({ resource: "Practitioner" }))
            : updated;
        }),

      getMine: (userId) =>
        repo
          .findByUserId(userId)
          .pipe(
            Effect.flatMap((found) =>
              found === undefined
                ? Effect.fail(new NotFound({ resource: "Practitioner profile" }))
                : Effect.succeed(found),
            ),
          ),

      updatePublicProfile: (userId, patch) =>
        Effect.gen(function* () {
          const now = new Date(yield* Clock.currentTimeMillis);
          const updated = yield* repo.updatePublic(userId, patch, now);
          if (updated === undefined) {
            return yield* Effect.fail(new NotFound({ resource: "Practitioner profile" }));
          }
          // Re-geocode only when the location actually changed.
          if (patch.location !== undefined) {
            yield* geocodeAndStore(userId, patch.location);
          }
          return updated;
        }),

      getPublic: (id) =>
        Effect.gen(function* () {
          const found = yield* repo.findById(id);
          // Only verified practitioners are publicly listable.
          if (found === undefined || found.verificationStatus !== "verified") {
            return yield* Effect.fail(new NotFound({ resource: "Practitioner", id }));
          }
          const photoUrl =
            found.profilePhotoFileKey === null
              ? null
              : yield* storage.presignDownload(found.profilePhotoFileKey);
          const now = new Date(yield* Clock.currentTimeMillis);
          const nextAvailableAt = yield* availability.nextAvailableAt(found.id, now);
          return { practitioner: found, photoUrl, nextAvailableAt };
        }),
    } satisfies PractitionerServiceService;
  }),
);
