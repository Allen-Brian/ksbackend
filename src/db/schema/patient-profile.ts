import { date, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { sexEnum } from "./enums";

// A patient's profile — kept separate from the better-auth `user` so the account
// holder ≠ patient distinction (and future dependents) hold. Cascades on user delete.
export const patientProfile = pgTable("patient_profile", {
  id: uuid("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => user.id, { onDelete: "cascade" }),
  surname: text("surname").notNull(),
  givenNames: text("given_names").notNull(),
  phone: text("phone"),
  dateOfBirth: date("date_of_birth").notNull(),
  sex: sexEnum("sex").notNull(),
  consentAcceptedAt: timestamp("consent_accepted_at", { withTimezone: true }).notNull(),
  consentVersion: text("consent_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
