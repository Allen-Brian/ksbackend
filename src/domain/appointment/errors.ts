import { Data } from "effect";

/** The selected slot is no longer bookable — taken, held by someone else, or gone from the schedule. */
export class SlotUnavailable extends Data.TaggedError("SlotUnavailable")<{
  readonly slotKey?: string;
}> {}

/** The checkout hold lapsed before it was confirmed. */
export class HoldExpired extends Data.TaggedError("HoldExpired")<{
  readonly appointmentId: string;
}> {}

/** The booker holds no active caregiver link to the requested care subject. */
export class NotACaregiver extends Data.TaggedError("NotACaregiver")<{
  readonly subject: string;
}> {}

/** The transition isn't allowed from the appointment's current status. */
export class AppointmentStateInvalid extends Data.TaggedError("AppointmentStateInvalid")<{
  readonly current: string;
}> {}

/** The booker already has the maximum number of live (held or confirmed, upcoming) appointments. */
export class BookingLimitReached extends Data.TaggedError("BookingLimitReached")<{
  readonly limit: number;
}> {}

/** Cancellation is refused because the appointment starts within the cutoff window. */
export class CancellationWindowClosed extends Data.TaggedError("CancellationWindowClosed")<{
  readonly cutoffHours: number;
}> {}
