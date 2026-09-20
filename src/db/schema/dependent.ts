import { date, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sexEnum } from "./enums";

// A dependent PERSON (no login) that account holders book care for. Ownership +
// the per-caregiver relationship live on `caregiver_link` (M:N) — a dependent can
// have several caregivers. Soft-deleted so history survives. The emergency
// contact is someone LOCAL to the dependent (the caregiver is often abroad).
export const dependent = pgTable("dependent", {
  id: uuid("id").primaryKey(),
  surname: text("surname").notNull(),
  givenNames: text("given_names").notNull(),
  dateOfBirth: date("date_of_birth").notNull(),
  sex: sexEnum("sex").notNull(),
  phone: text("phone"),
  location: text("location"),
  emergencyContactName: text("emergency_contact_name"),
  emergencyContactPhone: text("emergency_contact_phone"),
  emergencyContactRelationship: text("emergency_contact_relationship"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
