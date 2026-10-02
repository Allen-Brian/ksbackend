import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { consultationOffering } from "./consultation-offering";
import { dependent } from "./dependent";
import { appointmentStatusEnum, consultationTypeEnum } from "./enums";
import { practiceLocation } from "./practice-location";
import { practitionerProfile } from "./practitioner-profile";

// A patient's reservation of one canonical schedule slot. `held` is the checkout
// hold (released lazily once `hold_expires_at` passes); `confirmed` is the seam
// where payment authorization will later run. The care subject is the booker
// themself (both subject columns null), a managed dependent, or a linked
// dependent account — never both. The no-double-booking invariant is the
// exclusion constraint in drizzle/0010 (tstzrange overlap on live rows), which
// drizzle-kit cannot express in this schema.
export const appointment = pgTable(
  "appointment",
  {
    id: uuid("id").primaryKey(),
    practitionerProfileId: uuid("practitioner_profile_id")
      .notNull()
      .references(() => practitionerProfile.id, { onDelete: "cascade" }),
    bookerUserId: text("booker_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    dependentId: uuid("dependent_id").references(() => dependent.id, { onDelete: "set null" }),
    subjectUserId: text("subject_user_id").references(() => user.id, { onDelete: "set null" }),
    offeringId: uuid("offering_id")
      .notNull()
      .references(() => consultationOffering.id),
    consultationType: consultationTypeEnum("consultation_type").notNull(),
    locationId: uuid("location_id").references(() => practiceLocation.id),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    // The canonical slot identity the client selected (rule:/exception:/explicit:).
    scheduleTimezone: text("schedule_timezone").notNull().default("Africa/Douala"),
    revision: integer("revision").notNull().default(0),
    slotKey: text("slot_key").notNull(),
    preferredLanguage: text("preferred_language").notNull(),
    status: appointmentStatusEnum("status").notNull().default("held"),
    holdExpiresAt: timestamp("hold_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Live rows per practitioner in time order: the agenda + the availability
    // subtraction both scan exactly this.
    index("appointment_practitioner_live_idx")
      .on(t.practitionerProfileId, t.startsAt)
      .where(sql`${t.status} in ('held', 'confirmed')`),
    index("appointment_booker_idx").on(t.bookerUserId, t.id),
    index("appointment_subject_user_idx").on(t.subjectUserId, t.id),
    check("appointment_time_order", sql`${t.endsAt} > ${t.startsAt}`),
    check(
      "appointment_single_subject",
      sql`${t.dependentId} is null or ${t.subjectUserId} is null`,
    ),
    check(
      "appointment_hold_has_expiry",
      sql`${t.status} <> 'held' or ${t.holdExpiresAt} is not null`,
    ),
  ],
);
