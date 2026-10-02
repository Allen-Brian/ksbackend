import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { Effect } from "effect";
import type { Appointment, CareSubject } from "@/domain/appointment/appointment";
import type { AppEnv, AppRuntime } from "@/http/app-env";
import { makeRun } from "@/http/run";
import { CursorQuery, ErrorResponse } from "@/http/schemas";
import { CurrentUser } from "@/infra/auth";
import {
  AppointmentAlternativesQuery,
  AppointmentAlternativesResponse,
  RescheduleAppointmentBody,
  AgendaQuery,
  AgendaResponse,
  AppointmentResponse,
  AppointmentsPage,
  CreateAppointmentBody,
} from "./appointment.contract";
import { AppointmentService } from "./appointment.service";

const jsonBody = <T>(schema: T) => ({ content: { "application/json": { schema } } });
const idParam = z.object({ id: z.uuid().openapi({ description: "The appointment id." }) });

const toSubject = (subject: CareSubject) => ({
  kind: subject.kind,
  dependentId: subject.kind === "dependent" ? subject.dependentId : null,
  subjectUserId: subject.kind === "linked" ? subject.subjectUserId : null,
});

// The service already reports the effective status (lazy expiry applied).
const toResponse = (a: Appointment) => ({
  id: a.id,
  revision: a.revision,
  cancellationCutoffHours: a.cancellationCutoffHours,
  practitionerId: a.practitionerProfileId,
  status: a.status,
  startsAt: a.startsAt.toISOString(),
  endsAt: a.endsAt.toISOString(),
  consultationType: a.consultationType,
  offeringId: a.offeringId,
  locationId: a.locationId,
  slotKey: a.slotKey,
  preferredLanguage: a.preferredLanguage,
  subject: toSubject(a.subject),
  bookerUserId: a.bookerUserId,
  holdExpiresAt: a.holdExpiresAt === null ? null : a.holdExpiresAt.toISOString(),
  createdAt: a.createdAt.toISOString(),
});

const create = createRoute({
  method: "post",
  path: "/v1/appointments",
  tags: ["Appointments"],
  summary: "Hold a slot (start checkout)",
  description: [
    "Reserves the selected slot as a `held` appointment for the checkout window",
    "(`holdExpiresAt`, 10 minutes by default). Every client value is treated as a selection, not",
    "authority: the slot is re-derived from the practitioner's live schedule, the offering and",
    "location must belong to the practitioner and match the consultation type, and the language",
    "must be one they speak (`422` otherwise). Book for yourself (requires a completed patient",
    "profile — `409 PROFILE_INCOMPLETE`), for a managed dependent (`dependentId`) or for a linked",
    "dependent (`subjectUserId`); on-behalf bookings need an active caregiver link",
    "(`403 NOT_A_CAREGIVER`). Two patients can never hold the same time: the loser of a race gets",
    "`409 SLOT_UNAVAILABLE`, as does anyone whose view of the calendar was stale. Re-holding a slot",
    "you already hold for the same subject returns that same hold (its expiry is never extended).",
    "One account may have at most `APPOINTMENT_MAX_LIVE_PER_BOOKER` (default 10) upcoming",
    "held/confirmed appointments (`409 BOOKING_LIMIT_REACHED`), and bookings open 60 days ahead.",
    "Then call `POST /v1/appointments/{id}/confirm` before the hold expires.",
  ].join(" "),
  request: { body: jsonBody(CreateAppointmentBody) },
  responses: {
    201: { ...jsonBody(AppointmentResponse), description: "The held appointment." },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    403: { ...jsonBody(ErrorResponse), description: "Not an active caregiver of the subject." },
    404: {
      ...jsonBody(ErrorResponse),
      description: "Unknown/unverified practitioner or offering.",
    },
    409: {
      ...jsonBody(ErrorResponse),
      description:
        "`SLOT_UNAVAILABLE`, `PROFILE_INCOMPLETE`, `BOOKING_LIMIT_REACHED`, or a reused client id (`CONFLICT`).",
    },
    422: { ...jsonBody(ErrorResponse), description: "Incompatible selections." },
  },
});

const confirm = createRoute({
  method: "post",
  path: "/v1/appointments/{id}/confirm",
  tags: ["Appointments"],
  summary: "Confirm a held appointment",
  description: [
    "Turns the booker's `held` appointment into a `confirmed` one. This is where payment",
    "authorization will run once payments ship; today confirmation is immediate. Idempotent: a",
    "retried confirm returns the confirmed appointment again. `409 HOLD_EXPIRED` if the hold",
    "lapsed (book again), `409 APPOINTMENT_STATE_INVALID` if it was cancelled, `409",
    "SLOT_UNAVAILABLE` if the practitioner withdrew the slot meanwhile (the hold is released).",
    "An on-behalf hold is re-checked against the caregiver link at confirm time.",
  ].join(" "),
  request: { params: idParam },
  responses: {
    200: { ...jsonBody(AppointmentResponse), description: "The confirmed appointment." },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    403: { ...jsonBody(ErrorResponse), description: "The caregiver link was revoked." },
    404: { ...jsonBody(ErrorResponse), description: "No such appointment booked by the caller." },
    409: { ...jsonBody(ErrorResponse), description: "Hold expired or state doesn't allow it." },
  },
});

const cancel = createRoute({
  method: "post",
  path: "/v1/appointments/{id}/cancel",
  tags: ["Appointments"],
  summary: "Cancel an appointment you booked",
  description: [
    "Cancels a `held` or `confirmed` appointment and frees the slot immediately. Only the booker",
    "can cancel. Unconfirmed checkout holds may always be released; confirmed appointments use",
    "the cancellation cutoff captured when booked (legacy rows use the application default)",
    "(`409 CANCELLATION_WINDOW_CLOSED`). Idempotent on an already-cancelled appointment.",
  ].join(" "),
  request: { params: idParam },
  responses: {
    200: { ...jsonBody(AppointmentResponse), description: "The cancelled appointment." },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    404: { ...jsonBody(ErrorResponse), description: "No such appointment booked by the caller." },
    409: { ...jsonBody(ErrorResponse), description: "Expired hold, or inside the cutoff window." },
  },
});

const getOne = createRoute({
  method: "get",
  path: "/v1/appointments/{id}",
  tags: ["Appointments"],
  summary: "Get one appointment",
  description:
    "Visible to the booker, to a linked dependent it was booked for, and to the practitioner. Anyone else gets `404`.",
  request: { params: idParam },
  responses: {
    200: { ...jsonBody(AppointmentResponse), description: "The appointment." },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    404: { ...jsonBody(ErrorResponse), description: "Unknown, or not a party to it." },
  },
});

const listMine = createRoute({
  method: "get",
  path: "/v1/me/appointments",
  tags: ["Appointments"],
  summary: "List my appointments",
  description:
    "Appointments the signed-in user booked (for themself or on someone's behalf) plus those booked for them as a linked dependent. Newest first, cursor-paginated.",
  request: { query: CursorQuery },
  responses: {
    200: { ...jsonBody(AppointmentsPage), description: "A page of appointments." },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    422: { ...jsonBody(ErrorResponse), description: "Malformed cursor." },
  },
});

const agenda = createRoute({
  method: "get",
  path: "/v1/practitioners/me/agenda",
  tags: ["Appointments"],
  summary: "The practitioner's daily agenda",
  description: [
    "Live appointments (confirmed, plus unexpired holds labelled `held`) for one calendar day in",
    "the practice timezone, in start order, with who the consultation is for and who booked it.",
    "Defaults to today. Requires the `doctor`/`nurse` role.",
  ].join(" "),
  request: { query: AgendaQuery },
  responses: {
    200: { ...jsonBody(AgendaResponse), description: "The day's agenda." },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    403: { ...jsonBody(ErrorResponse), description: "Not a practitioner." },
    404: { ...jsonBody(ErrorResponse), description: "No practitioner profile." },
  },
});

const reschedule = createRoute({
  method: "post",
  path: "/v1/appointments/{id}/reschedule",
  tags: ["Appointments"],
  summary: "Move a confirmed appointment atomically",
  description:
    "Only the booker can move a confirmed appointment to a compatible slot with the same practitioner/offering. Cancellation terms captured at booking apply. A failed move preserves the original reservation. Retry the same operationId and payload to receive the original success without another move; stale expectedRevision or reused operationId returns 409.",
  request: { params: idParam, body: jsonBody(RescheduleAppointmentBody) },
  responses: {
    200: {
      ...jsonBody(AppointmentResponse),
      description: "Moved appointment, or replayed successful result.",
    },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    403: { ...jsonBody(ErrorResponse), description: "Caregiver authority revoked." },
    404: {
      ...jsonBody(ErrorResponse),
      description: "Unknown appointment or incompatible inactive offering.",
    },
    409: {
      ...jsonBody(ErrorResponse),
      description:
        "Slot unavailable, stale revision, operation reuse, invalid state, or cutoff closed.",
    },
    422: { ...jsonBody(ErrorResponse), description: "Invalid target selection." },
  },
});
const alternatives = createRoute({
  method: "get",
  path: "/v1/appointments/{id}/alternatives",
  tags: ["Appointments"],
  summary: "Find compatible rescheduling slots with the same practitioner",
  request: { params: idParam, query: AppointmentAlternativesQuery },
  responses: {
    200: {
      ...jsonBody(AppointmentAlternativesResponse),
      description: "Compatible slots, ordered soonest first.",
    },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    403: { ...jsonBody(ErrorResponse), description: "Caregiver authority revoked." },
    404: { ...jsonBody(ErrorResponse), description: "Unknown appointment." },
    409: { ...jsonBody(ErrorResponse), description: "Appointment cannot be rescheduled." },
    422: { ...jsonBody(ErrorResponse), description: "Invalid window or cursor." },
  },
});

export const registerAppointmentRoutes = (app: OpenAPIHono<AppEnv>, runtime: AppRuntime): void => {
  const { runAuth } = makeRun(runtime);

  app.openapi(reschedule, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* AppointmentService;
        const body = c.req.valid("json");
        const moved = yield* service.reschedule(user.id, c.req.valid("param").id, {
          ...body,
          startsAt: new Date(Date.parse(body.startsAt)),
        });
        return c.json(toResponse(moved), 200);
      }),
    ),
  );
  app.openapi(alternatives, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* AppointmentService;
        const query = c.req.valid("query");
        const page = yield* service.alternatives(user.id, c.req.valid("param").id, {
          ...query,
          from: new Date(Date.parse(query.from)),
          to: new Date(Date.parse(query.to)),
        });
        return c.json(
          {
            data: page.data.map((slot) => ({
              key: slot.key,
              startsAt: slot.startsAt.toISOString(),
              endsAt: slot.endsAt.toISOString(),
              consultationTypes: [...slot.consultationTypes],
              locationId: slot.locationId,
              source: slot.source,
            })),
            meta: page.meta,
          },
          200,
        );
      }),
    ),
  );
  app.openapi(create, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* AppointmentService;
        const body = c.req.valid("json");
        const subject: CareSubject =
          body.dependentId !== undefined
            ? { kind: "dependent", dependentId: body.dependentId }
            : body.subjectUserId !== undefined
              ? { kind: "linked", subjectUserId: body.subjectUserId }
              : { kind: "self" };
        const held = yield* service.hold(user.id, {
          id: body.id,
          practitionerProfileId: body.practitionerId,
          slotKey: body.slotKey,
          startsAt: new Date(Date.parse(body.startsAt)),
          consultationType: body.consultationType,
          offeringId: body.offeringId,
          locationId: body.locationId,
          subject,
          preferredLanguage: body.preferredLanguage,
        });
        return c.json(toResponse(held), 201);
      }),
    ),
  );

  app.openapi(confirm, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* AppointmentService;
        const confirmed = yield* service.confirm(user.id, c.req.valid("param").id);
        return c.json(toResponse(confirmed), 200);
      }),
    ),
  );

  app.openapi(cancel, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* AppointmentService;
        const cancelled = yield* service.cancel(user.id, c.req.valid("param").id);
        return c.json(toResponse(cancelled), 200);
      }),
    ),
  );

  app.openapi(getOne, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* AppointmentService;
        const found = yield* service.get(user.id, c.req.valid("param").id);
        return c.json(toResponse(found), 200);
      }),
    ),
  );

  app.openapi(listMine, (c) => {
    const { limit, cursor } = c.req.valid("query");
    return runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* AppointmentService;
        const page = yield* service.listMine(user.id, limit, cursor);
        return c.json({ data: page.data.map(toResponse), meta: page.meta }, 200);
      }),
    );
  });

  app.openapi(agenda, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* AppointmentService;
        const day = yield* service.agenda(user.id, c.req.valid("query").date);
        return c.json(
          {
            data: day.entries.map((entry) => ({
              id: entry.appointment.id,
              status: entry.appointment.status,
              startsAt: entry.appointment.startsAt.toISOString(),
              endsAt: entry.appointment.endsAt.toISOString(),
              consultationType: entry.appointment.consultationType,
              preferredLanguage: entry.appointment.preferredLanguage,
              offering: entry.offering,
              location: entry.location,
              patient: { kind: entry.appointment.subject.kind, displayName: entry.patientName },
              booker: { displayName: entry.bookerName },
            })),
            meta: {
              count: day.entries.length,
              date: day.date,
              from: day.from.toISOString(),
              to: day.to.toISOString(),
            },
          },
          200,
        );
      }),
    ),
  );
};
