import { SqlError } from "@effect/sql";
import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import { and, desc, eq, or } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { user } from "@/db/schema/auth";
import { caregiverLink } from "@/db/schema/caregiver-link";
import { consentAudit } from "@/db/schema/consent-audit";
import { profile } from "@/db/schema/profile";
import type { Relationship } from "@/domain/dependent/dependent";
import type { LinkStatus, UserCard } from "@/domain/invitation/invitation";

export type LinkRow = typeof caregiverLink.$inferSelect;

export type ConsentEvent = "invited" | "accepted" | "declined" | "revoked" | "upgraded";

export interface InvitationRepoService {
  readonly createInvite: (input: {
    readonly id: string;
    readonly caregiverUserId: string;
    readonly inviteIdentifier: string;
    readonly relationship: Relationship;
    readonly token: string;
    readonly expiresAt: Date;
    readonly now: Date;
  }) => Effect.Effect<LinkRow, SqlError.SqlError>;
  readonly findByToken: (token: string) => Effect.Effect<LinkRow | undefined, SqlError.SqlError>;
  readonly pendingExists: (
    caregiverUserId: string,
    inviteIdentifier: string,
  ) => Effect.Effect<boolean, SqlError.SqlError>;
  readonly activate: (
    linkId: string,
    subjectUserId: string,
    now: Date,
  ) => Effect.Effect<void, SqlError.SqlError>;
  readonly setStatus: (
    linkId: string,
    status: LinkStatus,
    now: Date,
  ) => Effect.Effect<void, SqlError.SqlError>;
  readonly findForParty: (
    linkId: string,
    userId: string,
  ) => Effect.Effect<LinkRow | undefined, SqlError.SqlError>;
  readonly listForUser: (
    userId: string,
    email: string,
  ) => Effect.Effect<ReadonlyArray<LinkRow>, SqlError.SqlError>;
  readonly searchByEmail: (email: string) => Effect.Effect<UserCard | undefined, SqlError.SqlError>;
  readonly audit: (input: {
    readonly id: string;
    readonly linkId: string;
    readonly actorUserId: string;
    readonly event: ConsentEvent;
  }) => Effect.Effect<void, SqlError.SqlError>;
}

export class InvitationRepo extends Context.Tag("InvitationRepo")<
  InvitationRepo,
  InvitationRepoService
>() {}

export const InvitationRepoLive = Layer.effect(
  InvitationRepo,
  Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;

    return {
      createInvite: (input) =>
        db
          .insert(caregiverLink)
          .values({
            id: input.id,
            caregiverUserId: input.caregiverUserId,
            subjectUserId: null,
            managedDependentId: null,
            inviteIdentifier: input.inviteIdentifier,
            inviteToken: input.token,
            relationship: input.relationship,
            status: "pending",
            expiresAt: input.expiresAt,
            invitedAt: input.now,
            createdAt: input.now,
            updatedAt: input.now,
          })
          .returning()
          .pipe(
            Effect.flatMap((rows) =>
              rows[0]
                ? Effect.succeed(rows[0])
                : Effect.dieMessage("invite insert returned no row"),
            ),
          ),

      findByToken: (token) =>
        db
          .select()
          .from(caregiverLink)
          .where(eq(caregiverLink.inviteToken, token))
          .limit(1)
          .pipe(Effect.map((rows) => rows[0])),

      pendingExists: (caregiverUserId, inviteIdentifier) =>
        db
          .select({ id: caregiverLink.id })
          .from(caregiverLink)
          .where(
            and(
              eq(caregiverLink.caregiverUserId, caregiverUserId),
              eq(caregiverLink.inviteIdentifier, inviteIdentifier),
              eq(caregiverLink.status, "pending"),
            ),
          )
          .limit(1)
          .pipe(Effect.map((rows) => rows.length > 0)),

      activate: (linkId, subjectUserId, now) =>
        db
          .update(caregiverLink)
          .set({ subjectUserId, status: "active", respondedAt: now, updatedAt: now })
          .where(eq(caregiverLink.id, linkId))
          .pipe(Effect.asVoid),

      setStatus: (linkId, status, now) =>
        db
          .update(caregiverLink)
          .set({ status, respondedAt: now, updatedAt: now })
          .where(eq(caregiverLink.id, linkId))
          .pipe(Effect.asVoid),

      findForParty: (linkId, userId) =>
        db
          .select()
          .from(caregiverLink)
          .where(
            and(
              eq(caregiverLink.id, linkId),
              or(
                eq(caregiverLink.caregiverUserId, userId),
                eq(caregiverLink.subjectUserId, userId),
              ),
            ),
          )
          .limit(1)
          .pipe(Effect.map((rows) => rows[0])),

      listForUser: (userId, email) =>
        db
          .select()
          .from(caregiverLink)
          .where(
            or(
              eq(caregiverLink.caregiverUserId, userId),
              eq(caregiverLink.subjectUserId, userId),
              and(eq(caregiverLink.inviteIdentifier, email), eq(caregiverLink.status, "pending")),
            ),
          )
          .orderBy(desc(caregiverLink.createdAt))
          .pipe(Effect.map((rows) => rows)),

      searchByEmail: (email) =>
        db
          .select({
            userId: user.id,
            name: user.name,
            surname: profile.surname,
            givenNames: profile.givenNames,
          })
          .from(user)
          .leftJoin(profile, eq(profile.userId, user.id))
          // A freshly signed-up invitee may not have completed a profile yet, so
          // fall back to the account name until they do.
          .where(eq(user.email, email))
          .limit(1)
          .pipe(
            Effect.map((rows) => {
              const row = rows[0];
              if (row === undefined) return undefined;
              const displayName =
                row.givenNames !== null && row.surname !== null
                  ? `${row.givenNames} ${row.surname}`
                  : row.name;
              return { userId: row.userId, displayName };
            }),
          ),

      audit: (input) =>
        db
          .insert(consentAudit)
          .values({
            id: input.id,
            linkId: input.linkId,
            actorUserId: input.actorUserId,
            event: input.event,
          })
          .pipe(Effect.asVoid),
    };
  }),
);
