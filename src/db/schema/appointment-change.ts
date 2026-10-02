import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { appointment } from "./appointment";
import { user } from "./auth";

// One successful reschedule per client operation id. The immutable result makes
// a lost-response replay safe even after a later reschedule/cancellation.
export const appointmentChange = pgTable(
  "appointment_change",
  {
    id: uuid("id").primaryKey(),
    appointmentId: uuid("appointment_id")
      .notNull()
      .references(() => appointment.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    requestFingerprint: text("request_fingerprint").notNull(),
    previousStartsAt: timestamp("previous_starts_at", { withTimezone: true }).notNull(),
    previousEndsAt: timestamp("previous_ends_at", { withTimezone: true }).notNull(),
    result: jsonb("result").$type<unknown>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("appointment_change_appointment_idx").on(t.appointmentId, t.id)],
);
