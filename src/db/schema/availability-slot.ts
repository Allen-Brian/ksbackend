import { sql } from "drizzle-orm";
import { check, index, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { availabilitySlotStatusEnum } from "./enums";
import { practitionerProfile } from "./practitioner-profile";

// A bookable time slot a practitioner publishes. `status` open|booked|cancelled is
// the seam for the later booking story (SCRUM-17); this feature only writes `open`
// (create) and soft-deletes (cancel). Search derives "next available" from the open,
// future, non-deleted rows.
export const availabilitySlot = pgTable(
  "availability_slot",
  {
    id: uuid("id").primaryKey(),
    practitionerProfileId: uuid("practitioner_profile_id")
      .notNull()
      .references(() => practitionerProfile.id, { onDelete: "cascade" }),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    status: availabilitySlotStatusEnum("status").notNull().default("open"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Makes MIN(starts_at) for next-available an index scan.
    index("availability_open_future_idx")
      .on(t.practitionerProfileId, t.startsAt)
      .where(sql`${t.status} = 'open' and ${t.deletedAt} is null`),
    check("availability_slot_time_order", sql`${t.endsAt} > ${t.startsAt}`),
  ],
);
