import { date, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { sexEnum, verificationStatusEnum } from "./enums";
import { profession } from "./profession";

// A practitioner's profile + verification state. Sensitive identifiers are stored
// encrypted (…Encrypted) with a deterministic HMAC (…Hmac, unique) for dedupe.
export const practitionerProfile = pgTable("practitioner_profile", {
  id: uuid("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => user.id, { onDelete: "cascade" }),
  professionId: uuid("profession_id")
    .notNull()
    .references(() => profession.id),
  prefix: text("prefix"),
  surname: text("surname").notNull(),
  givenNames: text("given_names").notNull(),
  phone: text("phone"),
  dateOfBirth: date("date_of_birth"),
  sex: sexEnum("sex"),
  location: text("location"),
  cmcNumberEncrypted: text("cmc_number_encrypted"),
  cmcNumberHmac: text("cmc_number_hmac").unique(),
  nicNumberEncrypted: text("nic_number_encrypted"),
  nicNumberHmac: text("nic_number_hmac").unique(),
  cmcCertificateFileKey: text("cmc_certificate_file_key"),
  nicFileKey: text("nic_file_key"),
  profilePhotoFileKey: text("profile_photo_file_key"),
  verificationStatus: verificationStatusEnum("verification_status").notNull().default("incomplete"),
  consentAcceptedAt: timestamp("consent_accepted_at", { withTimezone: true }).notNull(),
  consentVersion: text("consent_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
