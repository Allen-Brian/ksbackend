import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { caregiverLink } from "./caregiver-link";
import { consentEventEnum } from "./enums";

// Append-only log of consent events on a caregiver_link (invited/accepted/
// declined/revoked/upgraded) — who did what, when. Health-data access is
// consent-gated and must be reconstructable after the fact.
export const consentAudit = pgTable("consent_audit", {
  id: uuid("id").primaryKey(),
  linkId: uuid("link_id")
    .notNull()
    .references(() => caregiverLink.id, { onDelete: "cascade" }),
  actorUserId: text("actor_user_id").references(() => user.id, { onDelete: "set null" }),
  event: consentEventEnum("event").notNull(),
  meta: text("meta"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
