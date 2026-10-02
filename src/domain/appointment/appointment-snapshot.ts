import { Schema } from "effect";
// Decode persisted replay snapshots; never trust an untyped JSON value.
export const AppointmentSnapshot = Schema.Struct({
  id: Schema.String,
  revision: Schema.Number,
  scheduleTimezone: Schema.String,
  cancellationCutoffHours: Schema.NullOr(Schema.Number),
  practitionerProfileId: Schema.String,
  bookerUserId: Schema.String,
  subject: Schema.Union(
    Schema.Struct({ kind: Schema.Literal("self") }),
    Schema.Struct({ kind: Schema.Literal("dependent"), dependentId: Schema.String }),
    Schema.Struct({ kind: Schema.Literal("linked"), subjectUserId: Schema.String }),
  ),
  offeringId: Schema.String,
  consultationType: Schema.Literal("in_person", "video", "home_visit"),
  locationId: Schema.NullOr(Schema.String),
  startsAt: Schema.DateFromString,
  endsAt: Schema.DateFromString,
  slotKey: Schema.String,
  preferredLanguage: Schema.String,
  status: Schema.Literal("held", "confirmed", "cancelled", "expired"),
  holdExpiresAt: Schema.NullOr(Schema.DateFromString),
  createdAt: Schema.DateFromString,
  updatedAt: Schema.DateFromString,
});
