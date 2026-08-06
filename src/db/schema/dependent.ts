import { date, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { relationshipEnum, sexEnum } from "./enums";

// A dependent PERSON (no login) that an account holder books care for. Distinct
// from the "dependent" role. Soft-deleted so history survives.
export const dependent = pgTable("dependent", {
  id: uuid("id").primaryKey(),
  accountHolderUserId: text("account_holder_user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  surname: text("surname").notNull(),
  givenNames: text("given_names").notNull(),
  dateOfBirth: date("date_of_birth").notNull(),
  sex: sexEnum("sex").notNull(),
  relationship: relationshipEnum("relationship").notNull(),
  phone: text("phone"),
  location: text("location"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
