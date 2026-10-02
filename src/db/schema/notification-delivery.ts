import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { appointment } from "./appointment";
import { user } from "./auth";

export const notificationDelivery = pgTable(
  "notification_delivery",
  {
    id: uuid("id").primaryKey(),
    appointmentId: uuid("appointment_id")
      .notNull()
      .references(() => appointment.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    recipientUserId: text("recipient_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    frozenPayload: jsonb("frozen_payload"),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    state: text("state").notNull().default("pending"),
    acceptanceUnknown: boolean("acceptance_unknown").notNull().default(false),
    attempts: integer("attempts").notNull().default(0),
    firstAttemptAt: timestamp("first_attempt_at", { withTimezone: true }),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    providerId: text("provider_id"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("notification_delivery_dedupe_key").on(t.dedupeKey),
    index("notification_delivery_due_idx").on(t.state, t.dueAt),
    index("notification_delivery_appointment_idx").on(t.appointmentId, t.revision),
  ],
);
