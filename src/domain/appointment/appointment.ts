import type { ConsultationType } from "@/domain/practitioner/practitioner";

export const APPOINTMENT_STATUSES = ["held", "confirmed", "cancelled", "expired"] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

/**
 * Who the consultation is for. `self` is the booker; `dependent` is a managed
 * dependent (no login); `linked` is another account holder who accepted a
 * caregiver invitation. Exactly one shape per appointment.
 */
export type CareSubject =
  | { readonly kind: "self" }
  | { readonly kind: "dependent"; readonly dependentId: string }
  | { readonly kind: "linked"; readonly subjectUserId: string };

export type Appointment = {
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
  /** The persisted status — see `effectiveStatus` for what a caller should treat it as. */
  readonly status: AppointmentStatus;
  readonly holdExpiresAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/** What a booker submits to hold a slot. */
export type BookingInput = {
  readonly practitionerProfileId: string;
  readonly slotKey: string;
  readonly startsAt: Date;
  readonly consultationType: ConsultationType;
  readonly offeringId: string;
  readonly locationId: string | null;
  readonly subject: CareSubject;
  readonly preferredLanguage: string;
};

/**
 * Holds expire lazily: nothing sweeps them, so a `held` row past its expiry is
 * `expired` to every reader. Everything else is what the row says.
 */
export const effectiveStatus = (
  appointment: Pick<Appointment, "status" | "holdExpiresAt">,
  now: Date,
): AppointmentStatus =>
  appointment.status === "held" &&
  appointment.holdExpiresAt !== null &&
  appointment.holdExpiresAt.getTime() <= now.getTime()
    ? "expired"
    : appointment.status;

/** A live appointment occupies its slot: confirmed, or held and not yet expired. */
export const isLive = (
  appointment: Pick<Appointment, "status" | "holdExpiresAt">,
  now: Date,
): boolean => {
  const status = effectiveStatus(appointment, now);
  return status === "held" || status === "confirmed";
};

/**
 * Whether the booker may still cancel: the appointment starts more than
 * `cutoffHours` from now. A cutoff of 0 (the default) means "any time".
 */
export const withinCancellationWindow = (startsAt: Date, now: Date, cutoffHours: number): boolean =>
  startsAt.getTime() - now.getTime() > cutoffHours * 3_600_000;
