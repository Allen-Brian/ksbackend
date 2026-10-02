import { SqlClient, SqlError } from "@effect/sql";
import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import { and, asc, count, desc, eq, inArray, gt, isNull, lt, lte, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Context, Effect, Layer, Schema } from "effect";
import { AppointmentSnapshot } from "@/domain/appointment/appointment-snapshot";
import { appointmentChange } from "@/db/schema/appointment-change";
import { appointment } from "@/db/schema/appointment";
import { availabilitySlot } from "@/db/schema/availability-slot";
import { caregiverLink } from "@/db/schema/caregiver-link";
import { consultationOffering } from "@/db/schema/consultation-offering";
import { dependent } from "@/db/schema/dependent";
import { practiceLocation } from "@/db/schema/practice-location";
import { practitionerProfile } from "@/db/schema/practitioner-profile";
import { profile } from "@/db/schema/profile";
import type { Appointment, AppointmentStatus, CareSubject } from "@/domain/appointment/appointment";
import { BookingLimitReached } from "@/domain/appointment/errors";
import type { ConsultationType } from "@/domain/practitioner/practitioner";

type Row = typeof appointment.$inferSelect;

const toSubject = (row: Pick<Row, "dependentId" | "subjectUserId">): CareSubject =>
  row.dependentId !== null
    ? { kind: "dependent", dependentId: row.dependentId }
    : row.subjectUserId !== null
      ? { kind: "linked", subjectUserId: row.subjectUserId }
      : { kind: "self" };

const subjectColumns = (subject: CareSubject) => ({
  dependentId: subject.kind === "dependent" ? subject.dependentId : null,
  subjectUserId: subject.kind === "linked" ? subject.subjectUserId : null,
});

const toDomain = (row: Row): Appointment => ({
  id: row.id,
  cancellationCutoffHours: row.cancellationCutoffHours,
  revision: row.revision,
  scheduleTimezone: row.scheduleTimezone,
  practitionerProfileId: row.practitionerProfileId,
  bookerUserId: row.bookerUserId,
  subject: toSubject(row),
  offeringId: row.offeringId,
  consultationType: row.consultationType,
  locationId: row.locationId,
  startsAt: row.startsAt,
  endsAt: row.endsAt,
  slotKey: row.slotKey,
  preferredLanguage: row.preferredLanguage,
  status: row.status,
  holdExpiresAt: row.holdExpiresAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const first = <A>(rows: ReadonlyArray<A>, what: string): Effect.Effect<A> =>
  rows[0] === undefined ? Effect.dieMessage(`${what} returned no row.`) : Effect.succeed(rows[0]);

// A live row: confirmed, or held with an unexpired hold. Mirrors `isLive`.
const live = (now: Date) =>
  or(
    eq(appointment.status, "confirmed"),
    and(eq(appointment.status, "held"), gt(appointment.holdExpiresAt, now)),
  );

const PgErrorCode = Schema.Struct({ code: Schema.String });
const decodeCode = Schema.decodeUnknownOption(PgErrorCode);
const pgCodeOf = (error: SqlError.SqlError): string | undefined => {
  const direct = decodeCode(error.cause);
  if (direct._tag === "Some") return direct.value.code;
  const nested = Schema.decodeUnknownOption(Schema.Struct({ cause: PgErrorCode }))(error.cause);
  return nested._tag === "Some" ? nested.value.cause.code : undefined;
};

/** Postgres `exclusion_violation` — the no-overlap constraint rejected the insert. */
export const isExclusionViolation = (error: SqlError.SqlError): boolean =>
  pgCodeOf(error) === "23P01";

/** Postgres `unique_violation` — e.g. a client-supplied id lost a race. */
export const isUniqueViolation = (error: SqlError.SqlError): boolean => pgCodeOf(error) === "23505";

export type NewAppointmentRow = {
  readonly id: string;
  readonly practitionerProfileId: string;
  readonly bookerUserId: string;
  readonly subject: CareSubject;
  readonly offeringId: string;
  readonly consultationType: ConsultationType;
  readonly locationId: string | null;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly slotKey: string;
  readonly preferredLanguage: string;
  readonly cancellationCutoffHours: number;
  readonly holdExpiresAt: Date;
  /** Cap on the booker's live upcoming appointments (a retry of an existing hold is exempt). */
  readonly maxLive: number;
  readonly now: Date;
};

export type AgendaEntry = {
  readonly appointment: Appointment;
  readonly offering: {
    readonly id: string;
    readonly durationMin: number;
    readonly priceXaf: number;
  };
  readonly location: { readonly id: string; readonly label: string } | null;
  /** Display name of the care subject (the booker themself, a dependent, or a linked user). */
  readonly patientName: string;
  readonly bookerName: string;
};

export interface AppointmentRepoService {
  readonly lockOperation: (actorUserId: string) => Effect.Effect<void, SqlError.SqlError>;
  readonly lockExplicitSlots: (
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<void, SqlError.SqlError>;
  readonly findChange: (id: string) => Effect.Effect<
    | {
        readonly appointmentId: string;
        readonly actorUserId: string;
        readonly requestFingerprint: string;
        readonly result: Appointment;
      }
    | undefined,
    SqlError.SqlError
  >;
  readonly move: (input: {
    readonly id: string;
    readonly startsAt: Date;
    readonly endsAt: Date;
    readonly slotKey: string;
    readonly locationId: string | null;
    readonly now: Date;
  }) => Effect.Effect<Appointment, SqlError.SqlError>;
  readonly retireExpired: (
    practitionerId: string,
    from: Date,
    to: Date,
    now: Date,
  ) => Effect.Effect<void, SqlError.SqlError>;
  readonly recordChange: (input: {
    readonly operationId: string;
    readonly actorUserId: string;
    readonly fingerprint: string;
    readonly previous: Appointment;
    readonly result: Appointment;
    readonly now: Date;
  }) => Effect.Effect<void, SqlError.SqlError>;
  readonly practitionerCutoff: (id: string) => Effect.Effect<number | null, SqlError.SqlError>;
  readonly idExists: (id: string) => Effect.Effect<boolean, SqlError.SqlError>;
  readonly findById: (id: string) => Effect.Effect<Appointment | undefined, SqlError.SqlError>;
  readonly findForUpdate: (id: string) => Effect.Effect<Appointment | undefined, SqlError.SqlError>;
  /** Whether `caregiverUserId` holds an ACTIVE caregiver link to the account `subjectUserId`. */
  readonly hasActiveLinkToUser: (
    caregiverUserId: string,
    subjectUserId: string,
  ) => Effect.Effect<boolean, SqlError.SqlError>;
  /**
   * The reservation, to be wrapped in one transaction by the caller: lock the
   * booker, retire lapsed holds that would block the range, refresh the booker's
   * own live hold on the same slot + subject in place (else enforce the live cap
   * and insert). The exclusion constraint decides races between bookers.
   */
  readonly reserve: (
    row: NewAppointmentRow,
  ) => Effect.Effect<Appointment, BookingLimitReached | SqlError.SqlError>;
  readonly setStatus: (
    id: string,
    status: AppointmentStatus,
    now: Date,
  ) => Effect.Effect<Appointment, SqlError.SqlError>;
  /** `open` → `booked` on the explicit slot; false when it was no longer open. */
  readonly markExplicitSlotBooked: (slotId: string) => Effect.Effect<boolean, SqlError.SqlError>;
  readonly reopenExplicitSlot: (slotId: string) => Effect.Effect<void, SqlError.SqlError>;
  /** Appointments the user booked or is the linked subject of, newest id first. */
  readonly listForUser: (
    userId: string,
    limit: number,
    beforeId: string | undefined,
  ) => Effect.Effect<ReadonlyArray<Appointment>, SqlError.SqlError>;
  /** Live appointments of a practitioner in [from, to), in start order, with display data. */
  readonly listAgenda: (
    practitionerProfileId: string,
    from: Date,
    to: Date,
    now: Date,
  ) => Effect.Effect<ReadonlyArray<AgendaEntry>, SqlError.SqlError>;
}

export class AppointmentRepo extends Context.Tag("AppointmentRepo")<
  AppointmentRepo,
  AppointmentRepoService
>() {}

export const AppointmentRepoLive = Layer.effect(
  AppointmentRepo,
  Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;
    const sqlClient = yield* SqlClient.SqlClient;
    const bookerProfile = alias(profile, "booker_profile");
    const subjectProfile = alias(profile, "subject_profile");

    const sameSubject = (subject: CareSubject) => {
      const columns = subjectColumns(subject);
      return and(
        columns.dependentId === null
          ? isNull(appointment.dependentId)
          : eq(appointment.dependentId, columns.dependentId),
        columns.subjectUserId === null
          ? isNull(appointment.subjectUserId)
          : eq(appointment.subjectUserId, columns.subjectUserId),
      );
    };

    return {
      lockOperation: (actorUserId) =>
        sqlClient`select pg_advisory_xact_lock(hashtext(${actorUserId}))`.pipe(Effect.asVoid),
      lockExplicitSlots: (ids) =>
        ids.length === 0
          ? Effect.void
          : db
              .select({ id: availabilitySlot.id })
              .from(availabilitySlot)
              .where(inArray(availabilitySlot.id, [...ids]))
              .orderBy(asc(availabilitySlot.id))
              .for("update")
              .pipe(Effect.asVoid),
      findChange: (id) =>
        db
          .select()
          .from(appointmentChange)
          .where(eq(appointmentChange.id, id))
          .limit(1)
          .pipe(
            Effect.flatMap((rows) => {
              const row = rows[0];
              return row === undefined
                ? Effect.succeed(undefined)
                : Schema.decodeUnknown(AppointmentSnapshot)(row.result).pipe(
                    Effect.orDie,
                    Effect.map((result) => ({
                      appointmentId: row.appointmentId,
                      actorUserId: row.actorUserId,
                      requestFingerprint: row.requestFingerprint,
                      result,
                    })),
                  );
            }),
          ),
      move: (input) =>
        db
          .update(appointment)
          .set({
            startsAt: input.startsAt,
            endsAt: input.endsAt,
            slotKey: input.slotKey,
            locationId: input.locationId,
            revision: sql`${appointment.revision} + 1`,
            updatedAt: input.now,
          })
          .where(eq(appointment.id, input.id))
          .returning()
          .pipe(
            Effect.flatMap((rows) => first(rows, "Appointment reschedule")),
            Effect.map(toDomain),
          ),
      retireExpired: (practitionerId, from, to, now) =>
        db
          .update(appointment)
          .set({ status: "expired", revision: sql`${appointment.revision} + 1`, updatedAt: now })
          .where(
            and(
              eq(appointment.practitionerProfileId, practitionerId),
              eq(appointment.status, "held"),
              lte(appointment.holdExpiresAt, now),
              lt(appointment.startsAt, to),
              gt(appointment.endsAt, from),
            ),
          )
          .pipe(Effect.asVoid),
      recordChange: (input) =>
        Schema.encode(AppointmentSnapshot)(input.result).pipe(
          Effect.orDie,
          Effect.flatMap((result) =>
            db
              .insert(appointmentChange)
              .values({
                id: input.operationId,
                appointmentId: input.result.id,
                actorUserId: input.actorUserId,
                requestFingerprint: input.fingerprint,
                previousStartsAt: input.previous.startsAt,
                previousEndsAt: input.previous.endsAt,
                result,
                createdAt: input.now,
                updatedAt: input.now,
              })
              .pipe(Effect.asVoid),
          ),
        ),
      practitionerCutoff: (id) =>
        db
          .select({ cutoff: practitionerProfile.cancellationCutoffHours })
          .from(practitionerProfile)
          .where(eq(practitionerProfile.id, id))
          .limit(1)
          .pipe(Effect.map((rows) => rows[0]?.cutoff ?? null)),
      idExists: (id) =>
        db
          .select({ id: appointment.id })
          .from(appointment)
          .where(eq(appointment.id, id))
          .limit(1)
          .pipe(Effect.map((rows) => rows.length > 0)),

      findById: (id) =>
        db
          .select()
          .from(appointment)
          .where(eq(appointment.id, id))
          .limit(1)
          .pipe(Effect.map((rows) => (rows[0] ? toDomain(rows[0]) : undefined))),

      findForUpdate: (id) =>
        db
          .select()
          .from(appointment)
          .where(eq(appointment.id, id))
          .limit(1)
          .for("update")
          .pipe(Effect.map((rows) => (rows[0] ? toDomain(rows[0]) : undefined))),

      hasActiveLinkToUser: (caregiverUserId, subjectUserId) =>
        db
          .select({ id: caregiverLink.id })
          .from(caregiverLink)
          .where(
            and(
              eq(caregiverLink.caregiverUserId, caregiverUserId),
              eq(caregiverLink.subjectUserId, subjectUserId),
              eq(caregiverLink.status, "active"),
            ),
          )
          .limit(1)
          .pipe(Effect.map((rows) => rows.length > 0)),

      reserve: (row) =>
        Effect.gen(function* () {
          const columns = subjectColumns(row.subject);
          // 0. Serialise this booker's reservations for the rest of the
          //    transaction so the per-booker cap below can't be raced.
          yield* sqlClient`select pg_advisory_xact_lock(hashtext(${row.bookerUserId}))`;
          // 1. Lapsed holds still carry status 'held' (expiry is lazy) and would
          //    trip the exclusion constraint — retire the ones in the way.
          yield* db
            .update(appointment)
            .set({ status: "expired", updatedAt: row.now })
            .where(
              and(
                eq(appointment.practitionerProfileId, row.practitionerProfileId),
                eq(appointment.status, "held"),
                lte(appointment.holdExpiresAt, row.now),
                lt(appointment.startsAt, row.endsAt),
                gt(appointment.endsAt, row.startsAt),
              ),
            );
          // 2. Same booker, same subject, same slot: the retry refreshes the
          //    existing hold in place — same id, ORIGINAL expiry, so re-holding
          //    can never extend the checkout window.
          const refreshed = yield* db
            .update(appointment)
            .set({
              offeringId: row.offeringId,
              consultationType: row.consultationType,
              locationId: row.locationId,
              endsAt: row.endsAt,
              slotKey: row.slotKey,
              preferredLanguage: row.preferredLanguage,
              updatedAt: row.now,
            })
            .where(
              and(
                eq(appointment.practitionerProfileId, row.practitionerProfileId),
                eq(appointment.status, "held"),
                gt(appointment.holdExpiresAt, row.now),
                eq(appointment.bookerUserId, row.bookerUserId),
                eq(appointment.startsAt, row.startsAt),
                sameSubject(row.subject),
              ),
            )
            .returning();
          if (refreshed[0] !== undefined) return toDomain(refreshed[0]);
          // 3. One account may only lock so much of the calendar at once.
          const liveCount = yield* db
            .select({ n: count() })
            .from(appointment)
            .where(
              and(
                eq(appointment.bookerUserId, row.bookerUserId),
                gt(appointment.startsAt, row.now),
                live(row.now),
              ),
            );
          if ((liveCount[0]?.n ?? 0) >= row.maxLive) {
            return yield* Effect.fail(new BookingLimitReached({ limit: row.maxLive }));
          }
          // 4. Insert; a concurrent winner makes this fail with 23P01.
          const inserted = yield* db
            .insert(appointment)
            .values({
              id: row.id,
              practitionerProfileId: row.practitionerProfileId,
              bookerUserId: row.bookerUserId,
              dependentId: columns.dependentId,
              subjectUserId: columns.subjectUserId,
              offeringId: row.offeringId,
              consultationType: row.consultationType,
              locationId: row.locationId,
              startsAt: row.startsAt,
              endsAt: row.endsAt,
              slotKey: row.slotKey,
              preferredLanguage: row.preferredLanguage,
              status: "held",
              cancellationCutoffHours: row.cancellationCutoffHours,
              holdExpiresAt: row.holdExpiresAt,
              createdAt: row.now,
              updatedAt: row.now,
            })
            .returning();
          return toDomain(yield* first(inserted, "Appointment insert"));
        }),

      setStatus: (id, status, now) =>
        db
          .update(appointment)
          .set({
            status,
            revision: sql`${appointment.revision} + 1`,
            // Cleared once confirmed; kept on expired/cancelled rows for the audit trail.
            holdExpiresAt: status === "confirmed" ? null : undefined,
            updatedAt: now,
          })
          .where(eq(appointment.id, id))
          .returning()
          .pipe(
            Effect.flatMap((rows) => first(rows, "Appointment status update")),
            Effect.map(toDomain),
          ),

      markExplicitSlotBooked: (slotId) =>
        db
          .update(availabilitySlot)
          .set({ status: "booked" })
          .where(
            and(
              eq(availabilitySlot.id, slotId),
              eq(availabilitySlot.status, "open"),
              isNull(availabilitySlot.deletedAt),
            ),
          )
          .returning({ id: availabilitySlot.id })
          .pipe(Effect.map((rows) => rows.length > 0)),

      reopenExplicitSlot: (slotId) =>
        db
          .update(availabilitySlot)
          .set({ status: "open" })
          .where(
            and(
              eq(availabilitySlot.id, slotId),
              eq(availabilitySlot.status, "booked"),
              isNull(availabilitySlot.deletedAt),
            ),
          )
          .pipe(Effect.asVoid),

      listForUser: (userId, limit, beforeId) =>
        db
          .select()
          .from(appointment)
          .where(
            and(
              or(eq(appointment.bookerUserId, userId), eq(appointment.subjectUserId, userId)),
              beforeId === undefined ? undefined : lt(appointment.id, beforeId),
            ),
          )
          .orderBy(desc(appointment.id))
          .limit(limit)
          .pipe(Effect.map((rows) => rows.map(toDomain))),

      listAgenda: (practitionerProfileId, from, to, now) =>
        db
          .select({
            row: appointment,
            offering: {
              id: consultationOffering.id,
              durationMin: consultationOffering.durationMin,
              priceXaf: consultationOffering.priceXaf,
            },
            locationId: practiceLocation.id,
            locationLabel: practiceLocation.label,
            bookerSurname: bookerProfile.surname,
            bookerGivenNames: bookerProfile.givenNames,
            dependentSurname: dependent.surname,
            dependentGivenNames: dependent.givenNames,
            subjectSurname: subjectProfile.surname,
            subjectGivenNames: subjectProfile.givenNames,
          })
          .from(appointment)
          .innerJoin(consultationOffering, eq(appointment.offeringId, consultationOffering.id))
          .leftJoin(practiceLocation, eq(appointment.locationId, practiceLocation.id))
          .leftJoin(bookerProfile, eq(appointment.bookerUserId, bookerProfile.userId))
          .leftJoin(dependent, eq(appointment.dependentId, dependent.id))
          .leftJoin(subjectProfile, eq(appointment.subjectUserId, subjectProfile.userId))
          .where(
            and(
              eq(appointment.practitionerProfileId, practitionerProfileId),
              lt(appointment.startsAt, to),
              gt(appointment.endsAt, from),
              live(now),
            ),
          )
          .orderBy(asc(appointment.startsAt))
          .pipe(
            Effect.map((rows) =>
              rows.map((r) => {
                const booker = [r.bookerGivenNames, r.bookerSurname].filter(Boolean).join(" ");
                const subject =
                  r.row.dependentId !== null
                    ? [r.dependentGivenNames, r.dependentSurname].filter(Boolean).join(" ")
                    : r.row.subjectUserId !== null
                      ? [r.subjectGivenNames, r.subjectSurname].filter(Boolean).join(" ")
                      : booker;
                return {
                  appointment: toDomain(r.row),
                  offering: r.offering,
                  location:
                    r.locationId === null || r.locationLabel === null
                      ? null
                      : { id: r.locationId, label: r.locationLabel },
                  patientName: subject,
                  bookerName: booker,
                };
              }),
            ),
          ),
    } satisfies AppointmentRepoService;
  }),
);
