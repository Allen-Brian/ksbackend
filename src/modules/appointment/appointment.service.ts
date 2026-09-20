import { SqlClient, SqlError } from "@effect/sql";
import { Clock, Config, Context, Effect, Layer } from "effect";
import {
  type Appointment,
  type BookingInput,
  type CareSubject,
  effectiveStatus,
  withinCancellationWindow,
} from "@/domain/appointment/appointment";
import {
  AppointmentStateInvalid,
  BookingLimitReached,
  CancellationWindowClosed,
  HoldExpired,
  NotACaregiver,
  SlotUnavailable,
} from "@/domain/appointment/errors";
import type { PublicAvailabilitySlot } from "@/domain/availability/availability";
import { expandSchedule, scheduleDateKey, scheduleDayWindow } from "@/domain/availability/schedule";
import {
  Conflict,
  Forbidden,
  NotFound,
  ProfileIncomplete,
  ValidationFailed,
} from "@/domain/shared/errors";
import type { CurrentUser } from "@/infra/auth";
import { requireAnyRole } from "@/infra/authz";
import { IdGenerator } from "@/infra/ids";
import { decodeCursor, encodeCursor } from "@/lib/cursor";
import { AvailabilityRepo } from "@/modules/availability/availability.repo";
import { DependentRepo } from "@/modules/dependent/dependent.repo";
import { LocationRepo } from "@/modules/location/location.repo";
import { OfferingRepo } from "@/modules/offering/offering.repo";
import { PatientRepo } from "@/modules/patient/patient.repo";
import { PractitionerRepo } from "@/modules/practitioner/practitioner.repo";
import { ProfileRepo } from "@/modules/profile/profile.repo";
import {
  type AgendaEntry,
  AppointmentRepo,
  isExclusionViolation,
  isUniqueViolation,
} from "./appointment.repo";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Matches the public availability read's 60-day window (availability.service).
const BOOKING_HORIZON_DAYS = 60;
const EXPLICIT_PREFIX = "explicit:";
const explicitSlotId = (slotKey: string): string | undefined =>
  slotKey.startsWith(EXPLICIT_PREFIX) ? slotKey.slice(EXPLICIT_PREFIX.length) : undefined;

const invalid = (path: string, message: string) =>
  Effect.fail(new ValidationFailed({ issues: [{ path, message }] }));

export type AppointmentPage = {
  readonly data: ReadonlyArray<Appointment>;
  readonly meta: {
    readonly count: number;
    readonly limit: number;
    readonly nextCursor: string | null;
    readonly hasNextPage: boolean;
  };
};

export type Agenda = {
  readonly date: string;
  readonly from: Date;
  readonly to: Date;
  readonly entries: ReadonlyArray<AgendaEntry>;
};

export type HoldInput = BookingInput & { readonly id?: string | undefined };

export interface AppointmentServiceService {
  /** Reserve a slot as a `held` appointment for the checkout window. */
  readonly hold: (
    bookerUserId: string,
    input: HoldInput,
  ) => Effect.Effect<
    Appointment,
    | BookingLimitReached
    | Conflict
    | NotFound
    | NotACaregiver
    | ProfileIncomplete
    | SlotUnavailable
    | ValidationFailed
    | SqlError.SqlError
  >;
  readonly confirm: (
    userId: string,
    id: string,
  ) => Effect.Effect<
    Appointment,
    | AppointmentStateInvalid
    | HoldExpired
    | NotACaregiver
    | NotFound
    | ProfileIncomplete
    | SlotUnavailable
    | SqlError.SqlError
  >;
  readonly cancel: (
    userId: string,
    id: string,
  ) => Effect.Effect<
    Appointment,
    AppointmentStateInvalid | CancellationWindowClosed | NotFound | SqlError.SqlError
  >;
  /** Visible to the booker, the linked subject, and the practitioner; `NotFound` otherwise. */
  readonly get: (
    userId: string,
    id: string,
  ) => Effect.Effect<Appointment, NotFound | SqlError.SqlError>;
  readonly listMine: (
    userId: string,
    limit: number,
    cursor: string | undefined,
  ) => Effect.Effect<AppointmentPage, ValidationFailed | SqlError.SqlError>;
  /** The signed-in practitioner's live appointments for one schedule-timezone day. */
  readonly agenda: (
    userId: string,
    date: string | undefined,
  ) => Effect.Effect<Agenda, Forbidden | NotFound | SqlError.SqlError, CurrentUser>;
}

export class AppointmentService extends Context.Tag("AppointmentService")<
  AppointmentService,
  AppointmentServiceService
>() {}

export const AppointmentServiceLive = Layer.effect(
  AppointmentService,
  Effect.gen(function* () {
    const repo = yield* AppointmentRepo;
    const availability = yield* AvailabilityRepo;
    const practitioners = yield* PractitionerRepo;
    const offerings = yield* OfferingRepo;
    const locations = yield* LocationRepo;
    const patients = yield* PatientRepo;
    const profiles = yield* ProfileRepo;
    const dependents = yield* DependentRepo;
    const ids = yield* IdGenerator;
    const sql = yield* SqlClient.SqlClient;
    const holdTtlMinutes = yield* Config.integer("APPOINTMENT_HOLD_TTL_MINUTES").pipe(
      Config.withDefault(10),
    );
    const cancelCutoffHours = yield* Config.integer("APPOINTMENT_CANCEL_CUTOFF_HOURS").pipe(
      Config.withDefault(0),
    );
    const maxLivePerBooker = yield* Config.integer("APPOINTMENT_MAX_LIVE_PER_BOOKER").pipe(
      Config.withDefault(10),
    );

    const now = Effect.map(Clock.currentTimeMillis, (millis) => new Date(millis));
    // Reads report the status a caller should act on (a lapsed hold is `expired`).
    const asOf = (found: Appointment, current: Date): Appointment => ({
      ...found,
      status: effectiveStatus(found, current),
    });

    const requireVerified = (practitionerProfileId: string) =>
      practitioners
        .findById(practitionerProfileId)
        .pipe(
          Effect.flatMap((found) =>
            found === undefined || found.verificationStatus !== "verified"
              ? Effect.fail(new NotFound({ resource: "Practitioner", id: practitionerProfileId }))
              : Effect.succeed(found),
          ),
        );

    // Every care subject must be a fully identified patient; on-behalf bookings
    // additionally need an ACTIVE caregiver link from the booker, and the booker
    // must at least have a base profile (identity + accepted terms) — the doctor
    // needs a named contact for whoever made the booking.
    const requireSubject = (bookerUserId: string, subject: CareSubject) =>
      Effect.gen(function* () {
        switch (subject.kind) {
          case "self": {
            if ((yield* patients.findByUserId(bookerUserId)) === undefined) {
              return yield* Effect.fail(new ProfileIncomplete({ resource: "patient" }));
            }
            return;
          }
          case "dependent": {
            if (
              (yield* dependents.findForCaregiver(bookerUserId, subject.dependentId)) === undefined
            ) {
              return yield* Effect.fail(new NotACaregiver({ subject: subject.dependentId }));
            }
            if ((yield* profiles.findByUserId(bookerUserId)) === undefined) {
              return yield* Effect.fail(new ProfileIncomplete({ resource: "patient" }));
            }
            return;
          }
          case "linked": {
            if ((yield* profiles.findByUserId(bookerUserId)) === undefined) {
              return yield* Effect.fail(new ProfileIncomplete({ resource: "patient" }));
            }
            if (!(yield* repo.hasActiveLinkToUser(bookerUserId, subject.subjectUserId))) {
              return yield* Effect.fail(new NotACaregiver({ subject: subject.subjectUserId }));
            }
            if ((yield* patients.findByUserId(subject.subjectUserId)) === undefined) {
              return yield* Effect.fail(new ProfileIncomplete({ resource: "patient" }));
            }
            return;
          }
        }
      });

    // The canonical slot the client selected, re-derived from the live schedule
    // with the booker's own hold on it ignored (so a retry finds it free).
    const resolveSlot = (
      bookerUserId: string,
      input: BookingInput,
      current: Date,
    ): Effect.Effect<PublicAvailabilitySlot, SlotUnavailable | SqlError.SqlError> =>
      Effect.gen(function* () {
        // Start a day early: a slot generated by an overnight rule belongs to the
        // rule's weekday, which may be the calendar day before the slot starts.
        const from = new Date(input.startsAt.getTime() - 86_400_000);
        const to = new Date(input.startsAt.getTime() + 86_400_000);
        const { practitionerProfileId } = input;
        const data = yield* Effect.all(
          {
            rules: availability.listRules(practitionerProfileId),
            exceptions: availability.listExceptions(
              practitionerProfileId,
              scheduleDateKey(from),
              scheduleDateKey(to),
            ),
            explicitSlots: availability.listSlotsInRange(practitionerProfileId, from, to),
            reserved: availability.listReservedWindows(practitionerProfileId, from, to, current, {
              bookerUserId,
              dependentId: input.subject.kind === "dependent" ? input.subject.dependentId : null,
              subjectUserId: input.subject.kind === "linked" ? input.subject.subjectUserId : null,
              startsAt: input.startsAt,
            }),
          },
          { concurrency: 4 },
        );
        const slot = expandSchedule({ ...data, from, to, now: current }).find(
          (candidate) =>
            candidate.key === input.slotKey &&
            candidate.startsAt.getTime() === input.startsAt.getTime(),
        );
        return slot === undefined
          ? yield* Effect.fail(new SlotUnavailable({ slotKey: input.slotKey }))
          : slot;
      });

    const hold: AppointmentServiceService["hold"] = (bookerUserId, input) =>
      Effect.gen(function* () {
        const practitioner = yield* requireVerified(input.practitionerProfileId);
        yield* requireSubject(bookerUserId, input.subject);

        const offering = yield* offerings.findOwned(input.practitionerProfileId, input.offeringId);
        if (offering === undefined || !offering.active) {
          return yield* Effect.fail(
            new NotFound({ resource: "Consultation offering", id: input.offeringId }),
          );
        }
        if (offering.consultationType !== input.consultationType) {
          return yield* invalid(
            "consultationType",
            "The offering is for a different consultation type.",
          );
        }
        if (
          practitioner.languagesSpoken !== null &&
          practitioner.languagesSpoken.length > 0 &&
          !practitioner.languagesSpoken.includes(input.preferredLanguage)
        ) {
          return yield* invalid(
            "preferredLanguage",
            "The practitioner does not consult in this language.",
          );
        }

        const current = yield* now;
        // Same horizon the public availability read enforces; without it a rule
        // with no validTo lets one account lock a calendar years out.
        if (input.startsAt.getTime() > current.getTime() + BOOKING_HORIZON_DAYS * 86_400_000) {
          return yield* invalid("startsAt", `Bookings open ${BOOKING_HORIZON_DAYS} days ahead.`);
        }
        const slot = yield* resolveSlot(bookerUserId, input, current);
        if (!slot.consultationTypes.includes(input.consultationType)) {
          return yield* invalid("consultationType", "This slot is not offered for that type.");
        }
        if (offering.durationMin * 60_000 > slot.endsAt.getTime() - slot.startsAt.getTime()) {
          return yield* invalid("offeringId", "The offering is longer than the selected slot.");
        }

        // Video happens nowhere; a location on the slot or in the request is
        // irrelevant to it. In-person needs one; home visits are at the patient's.
        const locationId =
          input.consultationType === "video" ? null : (input.locationId ?? slot.locationId);
        if (
          locationId !== null &&
          input.locationId !== null &&
          slot.locationId !== null &&
          input.locationId !== slot.locationId
        ) {
          return yield* invalid("locationId", "The slot is scheduled at a different location.");
        }
        if (locationId !== null) {
          const location = yield* locations.findOwned(input.practitionerProfileId, locationId);
          if (location === undefined) {
            return yield* invalid("locationId", "Location is not owned by this practitioner.");
          }
          if (!location.consultationTypes.includes(input.consultationType)) {
            return yield* invalid(
              "locationId",
              "This location does not host that consultation type.",
            );
          }
        } else if (input.consultationType === "in_person") {
          return yield* invalid("locationId", "An in-person consultation needs a location.");
        }

        if (input.id !== undefined && (yield* repo.idExists(input.id))) {
          return yield* Effect.fail(
            new Conflict({ resource: "Appointment", reason: "ID is already in use." }),
          );
        }
        const id = input.id ?? (yield* ids.next);
        return yield* sql
          .withTransaction(
            repo.reserve({
              id,
              practitionerProfileId: input.practitionerProfileId,
              bookerUserId,
              subject: input.subject,
              offeringId: offering.id,
              consultationType: input.consultationType,
              locationId,
              startsAt: slot.startsAt,
              endsAt: slot.endsAt,
              slotKey: slot.key,
              preferredLanguage: input.preferredLanguage,
              holdExpiresAt: new Date(current.getTime() + holdTtlMinutes * 60_000),
              maxLive: maxLivePerBooker,
              now: current,
            }),
          )
          .pipe(
            Effect.catchTag("SqlError", (error) => {
              const mapped: Conflict | SlotUnavailable | SqlError.SqlError = isExclusionViolation(
                error,
              )
                ? new SlotUnavailable({ slotKey: input.slotKey })
                : isUniqueViolation(error)
                  ? new Conflict({ resource: "Appointment", reason: "ID is already in use." })
                  : error;
              return Effect.fail(mapped);
            }),
          );
      });

    const ownedByBooker = (userId: string, id: string) =>
      repo
        .findById(id)
        .pipe(
          Effect.flatMap((found) =>
            found === undefined || found.bookerUserId !== userId
              ? Effect.fail(new NotFound({ resource: "Appointment", id }))
              : Effect.succeed(found),
          ),
        );

    const confirm: AppointmentServiceService["confirm"] = (userId, id) =>
      Effect.gen(function* () {
        const found = yield* ownedByBooker(userId, id);
        const current = yield* now;
        const status = effectiveStatus(found, current);
        // Idempotent: a retried confirm after a dropped response is a no-op.
        if (status === "confirmed") return found;
        if (status === "expired") {
          if (found.status === "held") yield* repo.setStatus(id, "expired", current);
          return yield* Effect.fail(new HoldExpired({ appointmentId: id }));
        }
        if (status === "cancelled") {
          return yield* Effect.fail(new AppointmentStateInvalid({ current: status }));
        }
        // Consent can be withdrawn between hold and confirm.
        if (found.subject.kind !== "self") yield* requireSubject(userId, found.subject);
        const slotId = explicitSlotId(found.slotKey);
        const confirmed = yield* sql.withTransaction(
          Effect.gen(function* () {
            if (slotId !== undefined && !(yield* repo.markExplicitSlotBooked(slotId))) {
              // The doctor withdrew the slot meanwhile: release the hold rather
              // than leave it blocking the time until it expires.
              yield* repo.setStatus(id, "cancelled", current);
              return undefined;
            }
            return yield* repo.setStatus(id, "confirmed", current);
          }),
        );
        return confirmed === undefined
          ? yield* Effect.fail(new SlotUnavailable({ slotKey: found.slotKey }))
          : confirmed;
      });

    const cancel: AppointmentServiceService["cancel"] = (userId, id) =>
      Effect.gen(function* () {
        const found = yield* ownedByBooker(userId, id);
        const current = yield* now;
        const status = effectiveStatus(found, current);
        if (status === "cancelled") return found;
        if (status === "expired") {
          return yield* Effect.fail(new AppointmentStateInvalid({ current: status }));
        }
        if (!withinCancellationWindow(found.startsAt, current, cancelCutoffHours)) {
          return yield* Effect.fail(
            new CancellationWindowClosed({ cutoffHours: cancelCutoffHours }),
          );
        }
        const slotId = explicitSlotId(found.slotKey);
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            if (status === "confirmed" && slotId !== undefined) {
              yield* repo.reopenExplicitSlot(slotId);
            }
            return yield* repo.setStatus(id, "cancelled", current);
          }),
        );
      });

    const get: AppointmentServiceService["get"] = (userId, id) =>
      Effect.gen(function* () {
        const found = yield* repo.findById(id);
        if (found === undefined)
          return yield* Effect.fail(new NotFound({ resource: "Appointment", id }));
        const isParty =
          found.bookerUserId === userId ||
          (found.subject.kind === "linked" && found.subject.subjectUserId === userId) ||
          (yield* practitioners.findByUserId(userId))?.id === found.practitionerProfileId;
        if (!isParty) return yield* Effect.fail(new NotFound({ resource: "Appointment", id }));
        return asOf(found, yield* now);
      });

    const listMine: AppointmentServiceService["listMine"] = (userId, limit, cursor) =>
      Effect.gen(function* () {
        let beforeId: string | undefined;
        if (cursor !== undefined) {
          const decoded = decodeCursor(cursor);
          if (!UUID_RE.test(decoded)) return yield* invalid("cursor", "Invalid cursor.");
          beforeId = decoded;
        }
        const current = yield* now;
        const rows = yield* repo.listForUser(userId, limit + 1, beforeId);
        const hasNextPage = rows.length > limit;
        const data = (hasNextPage ? rows.slice(0, limit) : rows).map((row) => asOf(row, current));
        const last = data.at(-1);
        return {
          data,
          meta: {
            count: data.length,
            limit,
            nextCursor: hasNextPage && last ? encodeCursor(last.id) : null,
            hasNextPage,
          },
        };
      });

    const agenda: AppointmentServiceService["agenda"] = (userId, date) =>
      Effect.gen(function* () {
        yield* requireAnyRole("doctor", "nurse");
        const practitionerProfileId = (yield* practitioners.findByUserId(userId))?.id;
        if (practitionerProfileId === undefined) {
          return yield* Effect.fail(new NotFound({ resource: "Practitioner profile" }));
        }
        const current = yield* now;
        const day = date ?? scheduleDateKey(current);
        const { from, to } = scheduleDayWindow(day);
        const entries = yield* repo.listAgenda(practitionerProfileId, from, to, current);
        return { date: day, from, to, entries };
      });

    return { hold, confirm, cancel, get, listMine, agenda } satisfies AppointmentServiceService;
  }),
);
