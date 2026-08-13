import { SqlError } from "@effect/sql";
import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import { and, desc, eq, lt, ne, or } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { user } from "@/db/schema/auth";
import { practitionerProfile } from "@/db/schema/practitioner-profile";
import { profile } from "@/db/schema/profile";
import { verificationReview } from "@/db/schema/verification-review";
import type {
  Practitioner,
  PublicProfilePatch,
  VerificationStatus,
} from "@/domain/practitioner/practitioner";
import { parseRoles, type Role, serializeRoles } from "@/infra/auth";
import type { Locale } from "@/infra/i18n";

type Row = typeof practitionerProfile.$inferSelect;
type Insert = typeof practitionerProfile.$inferInsert;
type ProfileRow = typeof profile.$inferSelect;

// Identity/contact come from the base profile; the professional fields + verification
// state from practitioner_profile. Every read joins the two.
const toDomain = (p: Row, base: ProfileRow): Practitioner => ({
  id: p.id,
  userId: p.userId,
  professionId: p.professionId,
  prefix: p.prefix,
  surname: base.surname,
  givenNames: base.givenNames,
  phone: base.phone,
  dateOfBirth: base.dateOfBirth,
  sex: base.sex,
  location: p.location,
  specialty: p.specialty,
  bio: p.bio,
  languagesSpoken: p.languagesSpoken,
  yearsExperience: p.yearsExperience,
  consultationFeeXaf: p.consultationFeeXaf,
  cmcCertificateFileKey: p.cmcCertificateFileKey,
  nicFileKey: p.nicFileKey,
  profilePhotoFileKey: p.profilePhotoFileKey,
  verificationStatus: p.verificationStatus,
});

export type PractitionerWithSecrets = {
  readonly practitioner: Practitioner;
  readonly cmcNumberEncrypted: string | null;
  readonly nicNumberEncrypted: string | null;
};

export type CredentialPatch = {
  readonly cmcNumberEncrypted: string;
  readonly cmcNumberHmac: string;
  readonly nicNumberEncrypted: string;
  readonly nicNumberHmac: string;
  readonly cmcCertificateFileKey: string;
  readonly nicFileKey: string;
  readonly profilePhotoFileKey: string;
  readonly verificationStatus: VerificationStatus;
  readonly updatedAt: Date;
};

export interface PractitionerRepoService {
  readonly findByUserId: (
    userId: string,
  ) => Effect.Effect<Practitioner | undefined, SqlError.SqlError>;
  /** Insert the professional row (base profile is written separately by the service). */
  readonly create: (values: Insert) => Effect.Effect<void, SqlError.SqlError>;
  readonly grantRole: (userId: string, role: Role) => Effect.Effect<void, SqlError.SqlError>;
  readonly hasConflictingHmac: (
    userId: string,
    cmcHmac: string,
    nicHmac: string,
  ) => Effect.Effect<boolean, SqlError.SqlError>;
  readonly applyCredentials: (
    userId: string,
    patch: CredentialPatch,
  ) => Effect.Effect<Practitioner | undefined, SqlError.SqlError>;
  readonly updatePublic: (
    userId: string,
    patch: PublicProfilePatch,
    updatedAt: Date,
  ) => Effect.Effect<Practitioner | undefined, SqlError.SqlError>;
  readonly findById: (id: string) => Effect.Effect<Practitioner | undefined, SqlError.SqlError>;
  readonly findByIdWithSecrets: (
    id: string,
  ) => Effect.Effect<PractitionerWithSecrets | undefined, SqlError.SqlError>;
  readonly listByStatus: (
    status: VerificationStatus,
    limit: number,
    beforeId: string | undefined,
  ) => Effect.Effect<ReadonlyArray<Practitioner>, SqlError.SqlError>;
  readonly setStatus: (
    id: string,
    status: VerificationStatus,
    updatedAt: Date,
  ) => Effect.Effect<void, SqlError.SqlError>;
  readonly addReview: (values: {
    readonly id: string;
    readonly practitionerProfileId: string;
    readonly reviewerUserId: string;
    readonly decision: "approved" | "rejected";
    readonly reason: string | null;
  }) => Effect.Effect<void, SqlError.SqlError>;
  readonly findContact: (
    practitionerId: string,
  ) => Effect.Effect<
    { readonly email: string; readonly locale: Locale } | undefined,
    SqlError.SqlError
  >;
}

export class PractitionerRepo extends Context.Tag("PractitionerRepo")<
  PractitionerRepo,
  PractitionerRepoService
>() {}

export const PractitionerRepoLive = Layer.effect(
  PractitionerRepo,
  Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;

    const joined = () =>
      db
        .select({ practitioner: practitionerProfile, base: profile })
        .from(practitionerProfile)
        .innerJoin(profile, eq(practitionerProfile.userId, profile.userId));

    return {
      findByUserId: (userId) =>
        joined()
          .where(eq(practitionerProfile.userId, userId))
          .limit(1)
          .pipe(
            Effect.map((rows) =>
              rows[0] ? toDomain(rows[0].practitioner, rows[0].base) : undefined,
            ),
          ),

      create: (values) => db.insert(practitionerProfile).values(values).pipe(Effect.asVoid),

      grantRole: (userId, role) =>
        db
          .select({ role: user.role })
          .from(user)
          .where(eq(user.id, userId))
          .limit(1)
          .pipe(
            Effect.flatMap((rows) => {
              const next = serializeRoles([...parseRoles(rows[0]?.role), role]);
              return db.update(user).set({ role: next }).where(eq(user.id, userId));
            }),
            Effect.asVoid,
          ),

      hasConflictingHmac: (userId, cmcHmac, nicHmac) =>
        db
          .select({ id: practitionerProfile.id })
          .from(practitionerProfile)
          .where(
            and(
              ne(practitionerProfile.userId, userId),
              or(
                eq(practitionerProfile.cmcNumberHmac, cmcHmac),
                eq(practitionerProfile.nicNumberHmac, nicHmac),
              ),
            ),
          )
          .limit(1)
          .pipe(Effect.map((rows) => rows.length > 0)),

      applyCredentials: (userId, patch) =>
        db
          .update(practitionerProfile)
          .set(patch)
          .where(eq(practitionerProfile.userId, userId))
          .pipe(
            Effect.flatMap(() =>
              joined()
                .where(eq(practitionerProfile.userId, userId))
                .limit(1)
                .pipe(
                  Effect.map((rows) =>
                    rows[0] ? toDomain(rows[0].practitioner, rows[0].base) : undefined,
                  ),
                ),
            ),
          ),

      updatePublic: (userId, patch, updatedAt) =>
        db
          .update(practitionerProfile)
          .set({
            ...(patch.prefix !== undefined && { prefix: patch.prefix }),
            ...(patch.location !== undefined && { location: patch.location }),
            ...(patch.specialty !== undefined && { specialty: patch.specialty }),
            ...(patch.bio !== undefined && { bio: patch.bio }),
            ...(patch.languagesSpoken !== undefined && {
              languagesSpoken: [...patch.languagesSpoken],
            }),
            ...(patch.yearsExperience !== undefined && { yearsExperience: patch.yearsExperience }),
            ...(patch.consultationFeeXaf !== undefined && {
              consultationFeeXaf: patch.consultationFeeXaf,
            }),
            updatedAt,
          })
          .where(eq(practitionerProfile.userId, userId))
          .pipe(
            Effect.flatMap(() =>
              joined()
                .where(eq(practitionerProfile.userId, userId))
                .limit(1)
                .pipe(
                  Effect.map((rows) =>
                    rows[0] ? toDomain(rows[0].practitioner, rows[0].base) : undefined,
                  ),
                ),
            ),
          ),

      findById: (id) =>
        joined()
          .where(eq(practitionerProfile.id, id))
          .limit(1)
          .pipe(
            Effect.map((rows) =>
              rows[0] ? toDomain(rows[0].practitioner, rows[0].base) : undefined,
            ),
          ),

      findByIdWithSecrets: (id) =>
        joined()
          .where(eq(practitionerProfile.id, id))
          .limit(1)
          .pipe(
            Effect.map((rows) => {
              const row = rows[0];
              return row === undefined
                ? undefined
                : {
                    practitioner: toDomain(row.practitioner, row.base),
                    cmcNumberEncrypted: row.practitioner.cmcNumberEncrypted,
                    nicNumberEncrypted: row.practitioner.nicNumberEncrypted,
                  };
            }),
          ),

      listByStatus: (status, limit, beforeId) =>
        joined()
          .where(
            beforeId === undefined
              ? eq(practitionerProfile.verificationStatus, status)
              : and(
                  eq(practitionerProfile.verificationStatus, status),
                  lt(practitionerProfile.id, beforeId),
                ),
          )
          .orderBy(desc(practitionerProfile.id))
          .limit(limit)
          .pipe(Effect.map((rows) => rows.map((r) => toDomain(r.practitioner, r.base)))),

      setStatus: (id, status, updatedAt) =>
        db
          .update(practitionerProfile)
          .set({ verificationStatus: status, updatedAt })
          .where(eq(practitionerProfile.id, id))
          .pipe(Effect.asVoid),

      addReview: (values) => db.insert(verificationReview).values(values).pipe(Effect.asVoid),

      findContact: (practitionerId) =>
        db
          .select({ email: user.email, locale: user.locale })
          .from(practitionerProfile)
          .innerJoin(user, eq(practitionerProfile.userId, user.id))
          .where(eq(practitionerProfile.id, practitionerId))
          .limit(1)
          .pipe(
            Effect.map((rows) => {
              const row = rows[0];
              if (row === undefined) return undefined;
              const locale: Locale = row.locale === "en" ? "en" : "fr";
              return { email: row.email, locale };
            }),
          ),
    } satisfies PractitionerRepoService;
  }),
);
