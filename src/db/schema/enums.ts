import { pgEnum } from "drizzle-orm/pg-core";

export const sexEnum = pgEnum("sex", ["male", "female"]);

export const verificationStatusEnum = pgEnum("verification_status", [
  "incomplete",
  "pending_verification",
  "verified",
  "rejected",
]);

export const verificationDecisionEnum = pgEnum("verification_decision", ["approved", "rejected"]);

export const relationshipEnum = pgEnum("relationship", [
  "child",
  "parent",
  "spouse",
  "sibling",
  "other",
]);

export const notificationCategoryEnum = pgEnum("notification_category", [
  "appointments",
  "verification",
  "security",
  "account",
]);

export const adminScopeEnum = pgEnum("admin_scope", ["super_admin", "verification_reviewer"]);
