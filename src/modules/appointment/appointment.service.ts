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

export type RescheduleInput = {
  readonly operationId: string;
  readonly expectedRevision: number;
  readonly slotKey: string;
  readonly startsAt: Date;
  readonly locationId?: string | null | undefined;
};
export type AlternativeQuery = {
  readonly from: Date;
  readonly to: Date;
  readonly limit: number;
  readonly cursor?: string | undefined;
};
export type AlternativePage = {
  readonly data: ReadonlyArray<PublicAvailabilitySlot>;
  readonly meta: {
    readonly count: number;
    readonly limit: number;
    readonly nextCursor: string | null;
    readonly hasNextPage: boolean;
    readonly from: string;
    readonly to: string;
  };
};
type RescheduleError =
  | AppointmentStateInvalid
  | CancellationWindowClosed
  | Conflict
  | NotFound
  | NotACaregiver
  | ProfileIncomplete
  | SlotUnavailable
  | ValidationFailed
  | SqlError.SqlError;
export type HoldInput = BookingInput & { readonly id?: string | undefined };

export interface AppointmentServiceService {
  readonly reschedule: (
    userId: string,
    id: string,
    input: RescheduleInput,
  ) => Effect.Effect<Appointment, RescheduleError>;
  readonly alternatives: (
    userId: string,
    id: string,
    query: AlternativeQuery,
  ) => Effect.Effect<AlternativePage, RescheduleError>;
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
      exceptAppointmentId?: string,
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
            reserved: availability.listReservedWindows(
              practitionerProfileId,
              from,
              to,
              current,
              exceptAppointmentId === undefined
                ? {
                    bookerUserId,
                    dependentId:
                      input.subject.kind === "dependent" ? input.subject.dependentId : null,
                    subjectUserId:
                      input.subject.kind === "linked" ? input.subject.subjectUserId : null,
                    startsAt: input.startsAt,
                  }
                : undefined,
              exceptAppointmentId,
            ),
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
        const cutoff =
          (yield* repo.practitionerCutoff(input.practitionerProfileId)) ?? cancelCutoffHours;
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
              cancellationCutoffHours: cutoff,
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
        .findForUpdate(id)
        .pipe(
          Effect.flatMap((found) =>
            found === undefined || found.bookerUserId !== userId
              ? Effect.fail(new NotFound({ resource: "Appointment", id }))
              : Effect.succeed(found),
          ),
        );

    const confirm: AppointmentServiceService["confirm"] = (userId, id) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const found = yield* ownedByBooker(userId, id);
            const current = yield* now;
            const status = effectiveStatus(found, current);
            if (status === "confirmed") return { appointment: found };
            if (status === "expired") {
              if (found.status === "held") yield* repo.setStatus(id, "expired", current);
              return { error: new HoldExpired({ appointmentId: id }) };
            }
            if (status === "cancelled") {
              return yield* Effect.fail(new AppointmentStateInvalid({ current: status }));
            }
            if (found.subject.kind !== "self") yield* requireSubject(userId, found.subject);
            const slotId = explicitSlotId(found.slotKey);
            if (slotId !== undefined && !(yield* repo.markExplicitSlotBooked(slotId))) {
              yield* repo.setStatus(id, "cancelled", current);
              return { error: new SlotUnavailable({ slotKey: found.slotKey }) };
            }
            return { appointment: yield* repo.setStatus(id, "confirmed", current) };
          }),
        )
        .pipe(
          Effect.flatMap((result) =>
            "error" in result ? Effect.fail(result.error) : Effect.succeed(result.appointment),
          ),
        );

    const cancel: AppointmentServiceService["cancel"] = (userId, id) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const found = yield* ownedByBooker(userId, id);
          const current = yield* now;
          const status = effectiveStatus(found, current);
          if (status === "cancelled") return found;
          if (status === "expired") {
            return yield* Effect.fail(new AppointmentStateInvalid({ current: status }));
          }
          const cutoff = found.cancellationCutoffHours ?? cancelCutoffHours;
          if (
            status === "confirmed" &&
            !withinCancellationWindow(found.startsAt, current, cutoff)
          ) {
            return yield* Effect.fail(new CancellationWindowClosed({ cutoffHours: cutoff }));
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
        }),
      );

    const requireMovable = (found: Appointment, current: Date) =>
      Effect.gen(function* () {
        const status = effectiveStatus(found, current);
        if (status !== "confirmed")
          return yield* Effect.fail(new AppointmentStateInvalid({ current: status }));
        const cutoff = found.cancellationCutoffHours ?? cancelCutoffHours;
        if (!withinCancellationWindow(found.startsAt, current, cutoff)) {
          return yield* Effect.fail(new CancellationWindowClosed({ cutoffHours: cutoff }));
        }
        yield* requireVerified(found.practitionerProfileId);
        if (found.subject.kind !== "self") yield* requireSubject(found.bookerUserId, found.subject);
        const offering = yield* offerings.findOwned(found.practitionerProfileId, found.offeringId);
        if (offering === undefined || !offering.active)
          return yield* Effect.fail(
            new NotFound({ resource: "Consultation offering", id: found.offeringId }),
          );
        return offering;
      });

    const reschedule: AppointmentServiceService["reschedule"] = (userId, id, input) => {
      const fingerprint = JSON.stringify([
        id,
        input.expectedRevision,
        input.slotKey,
        input.startsAt.toISOString(),
        input.locationId ?? null,
      ]);
      return sql
        .withTransaction(
          Effect.gen(function* () {
            // Shared with hold's per-booker lock; always acquire before appointment row locks.
            yield* repo.lockOperation(userId);
            const replay = yield* repo.findChange(input.operationId);
            if (replay !== undefined) {
              if (
                replay.actorUserId !== userId ||
                replay.appointmentId !== id ||
                replay.requestFingerprint !== fingerprint
              ) {
                return yield* Effect.fail(
                  new Conflict({
                    resource: "Reschedule operation",
                    reason: "Operation id was used for a different request.",
                  }),
                );
              }
              return replay.result;
            }
            const found = yield* ownedByBooker(userId, id);
            const current = yield* now;
            if (found.revision !== input.expectedRevision) {
              return yield* Effect.fail(
                new Conflict({
                  resource: "Appointment",
                  reason: "Appointment changed; reload before rescheduling.",
                }),
              );
            }
            const offering = yield* requireMovable(found, current);
            if (
              found.slotKey === input.slotKey &&
              found.startsAt.getTime() === input.startsAt.getTime() &&
              (input.locationId === undefined || input.locationId === found.locationId)
            ) {
              yield* repo.recordChange({
                operationId: input.operationId,
                actorUserId: userId,
                fingerprint,
                previous: found,
                result: found,
                now: current,
              });
              return found;
            }
            if (input.startsAt.getTime() > current.getTime() + BOOKING_HORIZON_DAYS * 86_400_000) {
              return yield* invalid(
                "startsAt",
                `Bookings open ${BOOKING_HORIZON_DAYS} days ahead.`,
              );
            }
            const oldSlotId = explicitSlotId(found.slotKey);
            const newSlotId = explicitSlotId(input.slotKey);
            let slot = yield* resolveSlot(
              userId,
              {
                ...found,
                practitionerProfileId: found.practitionerProfileId,
                slotKey: input.slotKey,
                startsAt: input.startsAt,
              },
              current,
              found.id,
            );
            // Retire/lock expired appointment rows before explicit slots: confirm
            // acquires its appointment row before its slot, including at expiry.
            yield* repo.retireExpired(
              found.practitionerProfileId,
              slot.startsAt,
              slot.endsAt,
              current,
            );
            yield* repo.lockExplicitSlots(
              [oldSlotId, newSlotId].filter((value) => value !== undefined),
            );
            // An explicit slot can change while awaiting its lock; revalidate.
            slot = yield* resolveSlot(
              userId,
              { ...found, slotKey: input.slotKey, startsAt: input.startsAt },
              current,
              found.id,
            );
            if (
              !slot.consultationTypes.includes(found.consultationType) ||
              offering.durationMin * 60_000 > slot.endsAt.getTime() - slot.startsAt.getTime()
            ) {
              return yield* invalid(
                "slotKey",
                "The selected slot does not support this consultation.",
              );
            }
            const locationId =
              found.consultationType === "video"
                ? null
                : (input.locationId ?? slot.locationId ?? found.locationId);
            if (
              slot.locationId !== null &&
              input.locationId !== undefined &&
              input.locationId !== null &&
              input.locationId !== slot.locationId
            ) {
              return yield* invalid("locationId", "The slot is scheduled at a different location.");
            }
            if (locationId === null && found.consultationType === "in_person")
              return yield* invalid("locationId", "An in-person consultation needs a location.");
            if (locationId !== null) {
              const location = yield* locations.findOwned(found.practitionerProfileId, locationId);
              if (
                location === undefined ||
                !location.consultationTypes.includes(found.consultationType)
              )
                return yield* invalid(
                  "locationId",
                  "Location is incompatible with this consultation.",
                );
            }
            if (newSlotId !== undefined && !(yield* repo.markExplicitSlotBooked(newSlotId))) {
              return yield* Effect.fail(new SlotUnavailable({ slotKey: input.slotKey }));
            }
            const moved = yield* repo.move({
              id,
              startsAt: slot.startsAt,
              endsAt: slot.endsAt,
              slotKey: slot.key,
              locationId,
              now: current,
            });
            if (oldSlotId !== undefined) yield* repo.reopenExplicitSlot(oldSlotId);
            yield* repo.recordChange({
              operationId: input.operationId,
              actorUserId: userId,
              fingerprint,
              previous: found,
              result: moved,
              now: current,
            });
            return moved;
          }),
        )
        .pipe(
          Effect.catchTag("SqlError", (error) =>
            Effect.fail(
              isExclusionViolation(error)
                ? new SlotUnavailable({ slotKey: input.slotKey })
                : isUniqueViolation(error)
                  ? new Conflict({
                      resource: "Reschedule operation",
                      reason: "Operation id is already in use.",
                    })
                  : error,
            ),
          ),
        );
    };

    const alternatives: AppointmentServiceService["alternatives"] = (userId, id, query) =>
      Effect.gen(function* () {
        const found = yield* repo.findById(id);
        if (found === undefined || found.bookerUserId !== userId)
          return yield* Effect.fail(new NotFound({ resource: "Appointment", id }));
        const current = yield* now;
        const offering = yield* requireMovable(found, current);
        if (
          query.to.getTime() <= query.from.getTime() ||
          query.to.getTime() - query.from.getTime() > BOOKING_HORIZON_DAYS * 86_400_000 ||
          query.to.getTime() > current.getTime() + BOOKING_HORIZON_DAYS * 86_400_000
        ) {
          return yield* invalid("to", "Select a future window within the 60-day booking horizon.");
        }
        if (query.limit < 1 || query.limit > 100)
          return yield* invalid("limit", "Use a limit between 1 and 100.");
        const key = (slot: PublicAvailabilitySlot) => `${slot.startsAt.toISOString()}|${slot.key}`;
        const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
        if (
          after !== undefined &&
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\|(?:rule|exception|explicit):/.test(after)
        )
          return yield* invalid("cursor", "Invalid cursor.");
        const { practitionerProfileId } = found;
        // Include the preceding local day for rules that run overnight.
        const ruleFrom = new Date(query.from.getTime() - 86_400_000);
        const data = yield* Effect.all(
          {
            rules: availability.listRules(practitionerProfileId),
            exceptions: availability.listExceptions(
              practitionerProfileId,
              scheduleDateKey(ruleFrom),
              scheduleDateKey(query.to),
            ),
            explicitSlots: availability.listSlotsInRange(
              practitionerProfileId,
              query.from,
              query.to,
            ),
            reserved: availability.listReservedWindows(
              practitionerProfileId,
              query.from,
              query.to,
              current,
              undefined,
              found.id,
            ),
          },
          { concurrency: 4 },
        );
        const candidates = expandSchedule({
          ...data,
          from: query.from,
          to: query.to,
          now: current,
        }).filter(
          (slot) =>
            slot.key !== found.slotKey &&
            slot.consultationTypes.includes(found.consultationType) &&
            offering.durationMin * 60_000 <= slot.endsAt.getTime() - slot.startsAt.getTime() &&
            (after === undefined || key(slot) > after),
        );
        const hasNextPage = candidates.length > query.limit;
        const page = candidates.slice(0, query.limit);
        const last = page.at(-1);
        return {
          data: page,
          meta: {
            count: page.length,
            limit: query.limit,
            hasNextPage,
            nextCursor: hasNextPage && last !== undefined ? encodeCursor(key(last)) : null,
            from: query.from.toISOString(),
            to: query.to.toISOString(),
          },
        };
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

    return {
      hold,
      confirm,
      cancel,
      reschedule,
      alternatives,
      get,
      listMine,
      agenda,
    } satisfies AppointmentServiceService;
  }),
);
