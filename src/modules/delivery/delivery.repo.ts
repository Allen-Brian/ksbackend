import { SqlClient, SqlError } from "@effect/sql";
import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import { and, eq, gt, inArray, lt, lte, or, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { appointment } from "@/db/schema/appointment";
import { user } from "@/db/schema/auth";
import { caregiverLink } from "@/db/schema/caregiver-link";
import { notificationDelivery } from "@/db/schema/notification-delivery";
import { notificationPreference } from "@/db/schema/notification-preference";
import { practitionerProfile } from "@/db/schema/practitioner-profile";
import { profile } from "@/db/schema/profile";
import type { FrozenDelivery } from "@/domain/delivery/delivery";

type Row = typeof notificationDelivery.$inferSelect;
type Insert = typeof notificationDelivery.$inferInsert;
export type DeliveryRow = Row;
export type DeliveryContact = {
  readonly email: string;
  readonly emailVerified: boolean;
  readonly locale: string | null;
  readonly phone: string | null;
  readonly emailEnabled: boolean;
  readonly pushEnabled: boolean;
};
export type CurrentAppointment = {
  readonly id: string;
  readonly revision: number;
  readonly status: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly consultationType: string;
  readonly scheduleTimezone: string;
  readonly bookerUserId: string;
  readonly subjectUserId: string | null;
  readonly dependentId: string | null;
  readonly practitionerProfileId: string;
};

export class DeliveryRepo extends Context.Tag("DeliveryRepo")<
  DeliveryRepo,
  {
    readonly insert: (rows: ReadonlyArray<Insert>) => Effect.Effect<void, SqlError.SqlError>;
    readonly suppressPrevious: (
      appointmentId: string,
      revision: number,
      now: Date,
    ) => Effect.Effect<void, SqlError.SqlError>;
    readonly practitionerUserId: (
      id: string,
    ) => Effect.Effect<string | undefined, SqlError.SqlError>;
    readonly contact: (
      userId: string,
    ) => Effect.Effect<DeliveryContact | undefined, SqlError.SqlError>;
    readonly current: (
      id: string,
    ) => Effect.Effect<CurrentAppointment | undefined, SqlError.SqlError>;
    readonly caregiverActive: (
      caregiver: string,
      subjectUserId: string | null,
      dependentId: string | null,
    ) => Effect.Effect<boolean, SqlError.SqlError>;
    readonly claim: (input: {
      now: Date;
      limit: number;
      token: string;
      leaseUntil: Date;
    }) => Effect.Effect<ReadonlyArray<Row>, SqlError.SqlError>;
    readonly freeze: (input: {
      id: string;
      token: string;
      payload: FrozenDelivery;
      now: Date;
      leaseUntil: Date;
    }) => Effect.Effect<boolean, SqlError.SqlError>;
    readonly finish: (input: {
      id: string;
      token: string;
      state: string;
      now: Date;
      dueAt?: Date;
      providerId?: string;
      error?: string;
      acceptanceUnknown?: boolean;
    }) => Effect.Effect<void, SqlError.SqlError>;
    readonly futureConfirmed: (input: {
      now: Date;
      limit: number;
      cursor?: string;
    }) => Effect.Effect<
      ReadonlyArray<{
        id: string;
        revision: number;
        startsAt: Date;
        endsAt: Date;
        bookerUserId: string;
        subjectUserId: string | null;
        practitionerProfileId: string;
        consultationType: string;
        scheduleTimezone: string;
      }>,
      SqlError.SqlError
    >;
  }
>() {}

export const DeliveryRepoLive = Layer.effect(
  DeliveryRepo,
  Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;
    const client = yield* SqlClient.SqlClient;
    return {
      insert: (rows) =>
        rows.length === 0
          ? Effect.void
          : db
              .insert(notificationDelivery)
              .values([...rows])
              .onConflictDoNothing({ target: notificationDelivery.dedupeKey })
              .pipe(Effect.asVoid),
      suppressPrevious: (appointmentId, revision, now) =>
        db
          .update(notificationDelivery)
          .set({
            state: sql`case when ${notificationDelivery.acceptanceUnknown} then 'needs_review' else 'suppressed' end`,
            leaseToken: null,
            leaseUntil: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(notificationDelivery.appointmentId, appointmentId),
              lt(notificationDelivery.revision, revision),
              inArray(notificationDelivery.state, ["pending", "leased"]),
            ),
          )
          .pipe(Effect.asVoid),
      practitionerUserId: (id) =>
        db
          .select({ userId: practitionerProfile.userId })
          .from(practitionerProfile)
          .where(eq(practitionerProfile.id, id))
          .limit(1)
          .pipe(Effect.map((rows) => rows[0]?.userId)),
      contact: (userId) =>
        db
          .select({
            email: user.email,
            emailVerified: user.emailVerified,
            locale: user.locale,
            phone: profile.phone,
            emailEnabled: notificationPreference.email,
            pushEnabled: notificationPreference.push,
          })
          .from(user)
          .leftJoin(profile, eq(profile.userId, user.id))
          .leftJoin(
            notificationPreference,
            and(
              eq(notificationPreference.userId, user.id),
              eq(notificationPreference.category, "appointments"),
            ),
          )
          .where(eq(user.id, userId))
          .limit(1)
          .pipe(
            Effect.map((rows) => {
              const row = rows[0];
              return row === undefined
                ? undefined
                : {
                    ...row,
                    emailEnabled: row.emailEnabled ?? true,
                    pushEnabled: row.pushEnabled ?? false,
                  };
            }),
          ),
      current: (id) =>
        db
          .select({
            id: appointment.id,
            revision: appointment.revision,
            status: appointment.status,
            startsAt: appointment.startsAt,
            endsAt: appointment.endsAt,
            consultationType: appointment.consultationType,
            scheduleTimezone: appointment.scheduleTimezone,
            bookerUserId: appointment.bookerUserId,
            subjectUserId: appointment.subjectUserId,
            dependentId: appointment.dependentId,
            practitionerProfileId: appointment.practitionerProfileId,
          })
          .from(appointment)
          .where(eq(appointment.id, id))
          .limit(1)
          .for("update")
          .pipe(Effect.map((rows) => rows[0])),
      caregiverActive: (caregiver, subjectUserId, dependentId) =>
        db
          .select({ id: caregiverLink.id })
          .from(caregiverLink)
          .where(
            and(
              eq(caregiverLink.caregiverUserId, caregiver),
              eq(caregiverLink.status, "active"),
              subjectUserId !== null
                ? eq(caregiverLink.subjectUserId, subjectUserId)
                : dependentId !== null
                  ? eq(caregiverLink.managedDependentId, dependentId)
                  : sql`false`,
            ),
          )
          .limit(1)
          .pipe(Effect.map((rows) => rows.length > 0)),
      claim: ({ now, limit, token, leaseUntil }) =>
        client.withTransaction(
          Effect.gen(function* () {
            const rows = yield* db
              .select()
              .from(notificationDelivery)
              .where(
                and(
                  lte(notificationDelivery.dueAt, now),
                  or(
                    eq(notificationDelivery.state, "pending"),
                    and(
                      eq(notificationDelivery.state, "leased"),
                      lte(notificationDelivery.leaseUntil, now),
                    ),
                  ),
                ),
              )
              .orderBy(notificationDelivery.dueAt, notificationDelivery.id)
              .limit(limit)
              .for("update", { skipLocked: true });
            if (rows.length === 0) return [];
            return yield* db
              .update(notificationDelivery)
              .set({
                state: "leased",
                leaseToken: token,
                leaseUntil,
                attempts: sql`${notificationDelivery.attempts}+1`,
                firstAttemptAt: sql`coalesce(${notificationDelivery.firstAttemptAt},${now})`,
                updatedAt: now,
              })
              .where(
                inArray(
                  notificationDelivery.id,
                  rows.map((row) => row.id),
                ),
              )
              .returning();
          }),
        ),
      freeze: ({ id, token, payload, now, leaseUntil }) =>
        db
          .update(notificationDelivery)
          .set({ frozenPayload: payload, updatedAt: now, leaseUntil, acceptanceUnknown: true })
          .where(
            and(
              eq(notificationDelivery.id, id),
              eq(notificationDelivery.leaseToken, token),
              eq(notificationDelivery.state, "leased"),
              gt(notificationDelivery.leaseUntil, now),
            ),
          )
          .returning({ id: notificationDelivery.id })
          .pipe(Effect.map((rows) => rows.length > 0)),
      finish: ({ id, token, state, now, dueAt, providerId, error, acceptanceUnknown }) =>
        db
          .update(notificationDelivery)
          .set({
            state,
            leaseToken: null,
            leaseUntil: null,
            updatedAt: now,
            ...(dueAt !== undefined && { dueAt }),
            ...(providerId !== undefined && { providerId }),
            ...(error !== undefined && { lastError: error }),
            ...(acceptanceUnknown !== undefined && { acceptanceUnknown }),
          })
          .where(
            and(
              eq(notificationDelivery.id, id),
              eq(notificationDelivery.leaseToken, token),
              eq(notificationDelivery.state, "leased"),
            ),
          )
          .pipe(Effect.asVoid),
      futureConfirmed: ({ now, limit, cursor }) =>
        db
          .select({
            id: appointment.id,
            revision: appointment.revision,
            startsAt: appointment.startsAt,
            endsAt: appointment.endsAt,
            bookerUserId: appointment.bookerUserId,
            subjectUserId: appointment.subjectUserId,
            practitionerProfileId: appointment.practitionerProfileId,
            consultationType: appointment.consultationType,
            scheduleTimezone: appointment.scheduleTimezone,
          })
          .from(appointment)
          .where(
            and(
              eq(appointment.status, "confirmed"),
              gt(appointment.startsAt, now),
              cursor === undefined ? undefined : gt(appointment.id, cursor),
            ),
          )
          .orderBy(appointment.id)
          .limit(limit),
    } satisfies typeof DeliveryRepo.Service;
  }),
);
