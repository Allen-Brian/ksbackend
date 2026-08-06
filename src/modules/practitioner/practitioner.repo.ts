import { SqlError } from "@effect/sql";
import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import { and, desc, eq, lt, ne, or } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { user } from "@/db/schema/auth";
import { practitionerProfile } from "@/db/schema/practitioner-profile";
import { verificationReview } from "@/db/schema/verification-review";
import type { Locale } from "@/infra/i18n";
import type { Practitioner, Sex, VerificationStatus } from "@/domain/practitioner/practitioner";
import { parseRoles, type Role, serializeRoles } from "@/infra/auth";

type Row = typeof practitionerProfile.$inferSelect;
type Insert = typeof practitionerProfile.$inferInsert;

const toDomain = (row: Row): Practitioner => ({
  id: row.id,
  userId: row.userId,
  professionId: row.professionId,
  prefix: row.prefix,
  surname: row.surname,
  givenNames: row.givenNames,
  phone: row.phone,
  dateOfBirth: row.dateOfBirth,
  sex: row.sex,
  location: row.location,
  cmcCertificateFileKey: row.cmcCertificateFileKey,
  nicFileKey: row.nicFileKey,
  profilePhotoFileKey: row.profilePhotoFileKey,
  verificationStatus: row.verificationStatus,
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
  readonly create: (values: Insert) => Effect.Effect<Practitioner, SqlError.SqlError>;
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

    return {
      findByUserId: (userId) =>
        db
          .select()
          .from(practitionerProfile)
          .where(eq(practitionerProfile.userId, userId))
          .limit(1)
          .pipe(Effect.map((rows) => (rows[0] ? toDomain(rows[0]) : undefined))),

      create: (values) =>
        db
          .insert(practitionerProfile)
          .values(values)
          .returning()
          .pipe(
            Effect.flatMap((rows) =>
              rows[0]
                ? Effect.succeed(toDomain(rows[0]))
                : Effect.dieMessage("insert returned no row"),
            ),
          ),

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
          .returning()
          .pipe(Effect.map((rows) => (rows[0] ? toDomain(rows[0]) : undefined))),

      findById: (id) =>
        db
          .select()
          .from(practitionerProfile)
          .where(eq(practitionerProfile.id, id))
          .limit(1)
          .pipe(Effect.map((rows) => (rows[0] ? toDomain(rows[0]) : undefined))),

      findByIdWithSecrets: (id) =>
        db
          .select()
          .from(practitionerProfile)
          .where(eq(practitionerProfile.id, id))
          .limit(1)
          .pipe(
            Effect.map((rows) => {
              const row = rows[0];
              return row === undefined
                ? undefined
                : {
                    practitioner: toDomain(row),
                    cmcNumberEncrypted: row.cmcNumberEncrypted,
                    nicNumberEncrypted: row.nicNumberEncrypted,
                  };
            }),
          ),

      listByStatus: (status, limit, beforeId) =>
        db
          .select()
          .from(practitionerProfile)
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
          .pipe(Effect.map((rows) => rows.map(toDomain))),

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

// Re-export for the service's mapping convenience.
export type { Sex };
