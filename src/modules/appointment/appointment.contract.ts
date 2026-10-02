import { z } from "@hono/zod-openapi";
import { APPOINTMENT_STATUSES } from "@/domain/appointment/appointment";
import { CONSULTATION_TYPES } from "@/domain/practitioner/practitioner";
import { PublicSlotResponse } from "@/modules/availability/availability.contract";
import { paginated } from "@/http/schemas";

const status = z.enum(APPOINTMENT_STATUSES).openapi({
  description:
    "`held` while the booker is in checkout (see `holdExpiresAt`), `confirmed` once confirmed, `cancelled` by the booker, `expired` when a hold lapsed unconfirmed. Holds expire lazily — a lapsed hold is reported as `expired` even though nothing swept it.",
  example: "held",
});

const preferredLanguage = z
  .string()
  .regex(/^[a-z]{2}(-[A-Za-z]{2,4})?$/, "Use an ISO-639-1 code, e.g. fr")
  .openapi({
    description:
      "Language the patient wants the consultation in (ISO-639-1). Must be one the practitioner speaks.",
    example: "fr",
  });

export const CreateAppointmentBody = z
  .object({
    id: z.uuidv7().optional().openapi({
      description: "Optional client-generated UUIDv7 for optimistic UI. `409` if already used.",
    }),
    practitionerId: z.uuid().openapi({ description: "The practitioner profile id being booked." }),
    slotKey: z.string().min(1).max(200).openapi({
      description:
        "The `key` of the slot as returned by `GET /v1/practitioners/{id}/availability` (`rule:…`, `exception:…` or `explicit:…`).",
      example: "rule:0198e3f0-3000-7000-8000-000000000001:2026-10-05T08:00:00.000Z",
    }),
    startsAt: z.iso.datetime().openapi({
      description:
        "The slot's start as shown to the patient; re-validated against the live schedule.",
      example: "2026-10-05T08:00:00.000Z",
    }),
    consultationType: z.enum(CONSULTATION_TYPES).openapi({ example: "in_person" }),
    offeringId: z.uuid().openapi({
      description:
        "One of the practitioner's active consultation offerings (sets duration + price).",
    }),
    locationId: z.uuid().nullable().default(null).openapi({
      description:
        "Practice location for in-person visits. May be omitted when the slot itself carries one. Ignored for video.",
    }),
    dependentId: z.uuid().optional().openapi({
      description:
        "Book on behalf of a MANAGED dependent (no login). Requires an active caregiver link — `403 NOT_A_CAREGIVER` otherwise. Mutually exclusive with `subjectUserId`.",
    }),
    subjectUserId: z.string().min(1).max(64).optional().openapi({
      description:
        "Book on behalf of a LINKED dependent (an account holder who accepted your caregiver invitation). Mutually exclusive with `dependentId`.",
    }),
    preferredLanguage,
  })
  .refine((body) => body.dependentId === undefined || body.subjectUserId === undefined, {
    path: ["subjectUserId"],
    message: "Provide either dependentId or subjectUserId, not both.",
  })
  .openapi("CreateAppointment");

const CareSubjectResponse = z
  .object({
    kind: z.enum(["self", "dependent", "linked"]).openapi({
      description:
        "`self`: the booker is the patient. `dependent`: a managed dependent. `linked`: a linked account holder.",
    }),
    dependentId: z.uuid().nullable(),
    subjectUserId: z.string().nullable(),
  })
  .openapi("CareSubject");

export const AppointmentResponse = z
  .object({
    id: z.uuid(),
    revision: z.number().int().nonnegative(),
    cancellationCutoffHours: z.number().int().nonnegative().nullable(),
    practitionerId: z.uuid(),
    status,
    startsAt: z
      .string()
      .openapi({ description: "ISO-8601 start.", example: "2026-10-05T08:00:00.000Z" }),
    endsAt: z
      .string()
      .openapi({ description: "ISO-8601 end.", example: "2026-10-05T08:30:00.000Z" }),
    consultationType: z.enum(CONSULTATION_TYPES),
    offeringId: z.uuid(),
    locationId: z.uuid().nullable(),
    slotKey: z.string(),
    preferredLanguage: z.string(),
    subject: CareSubjectResponse,
    bookerUserId: z.string(),
    holdExpiresAt: z.string().nullable().openapi({
      description: "When a `held` appointment is released if not confirmed; null once confirmed.",
    }),
    createdAt: z.string(),
  })
  .openapi("Appointment");

export const AppointmentsPage = paginated(AppointmentResponse).openapi("AppointmentsPage");

export const AgendaQuery = z.object({
  date: z.iso.date().optional().openapi({
    description: "Calendar day in the practice timezone (Africa/Douala). Defaults to today.",
    example: "2026-10-05",
  }),
});

export const AgendaEntryResponse = z
  .object({
    id: z.uuid(),
    status,
    startsAt: z.string(),
    endsAt: z.string(),
    consultationType: z.enum(CONSULTATION_TYPES),
    preferredLanguage: z.string(),
    offering: z.object({
      id: z.uuid(),
      durationMin: z.number().int(),
      priceXaf: z.number().int(),
    }),
    location: z.object({ id: z.uuid(), label: z.string() }).nullable(),
    patient: z
      .object({
        kind: z.enum(["self", "dependent", "linked"]),
        displayName: z.string().openapi({ description: "Who the consultation is for." }),
      })
      .openapi({ description: "The care subject the doctor will see." }),
    booker: z.object({ displayName: z.string() }).openapi({
      description: "Who made the booking (the contact when it is on someone's behalf).",
    }),
  })
  .openapi("AgendaEntry");

export const AgendaResponse = z
  .object({
    data: z.array(AgendaEntryResponse),
    meta: z.object({
      count: z.number().int().nonnegative(),
      date: z.iso.date(),
      from: z.string(),
      to: z.string(),
    }),
  })
  .openapi("Agenda");

export const RescheduleAppointmentBody = z
  .object({
    operationId: z.uuidv7().openapi({
      description:
        "Unique client operation id. Retry the exact same payload to recover its original successful response.",
    }),
    expectedRevision: z
      .number()
      .int()
      .nonnegative()
      .openapi({ description: "Revision of the appointment last read. Stale edits return 409." }),
    slotKey: z.string().min(1).max(200),
    startsAt: z.iso.datetime(),
    locationId: z.uuid().nullable().optional(),
  })
  .strict()
  .openapi("RescheduleAppointment");
export const AppointmentAlternativesQuery = z.object({
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(1024).optional(),
});
export const AppointmentAlternativesResponse = z.object({
  data: z.array(PublicSlotResponse),
  meta: z.object({
    count: z.number().int().nonnegative(),
    limit: z.number().int(),
    nextCursor: z.string().nullable(),
    hasNextPage: z.boolean(),
    from: z.iso.datetime(),
    to: z.iso.datetime(),
  }),
});
