import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { verificationStatusEnum } from "./enums";
import { profession } from "./profession";

// The practitioner extension of the base `profile`: profession, verification state,
// and the sensitive identifiers (stored encrypted with a deterministic HMAC for
// dedupe). Common identity/contact/consent live on `profile`. Cascades on user delete.
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
  location: text("location"),
  // Public/bookable profile — shown to patients once verified (no sensitive data).
  specialty: text("specialty"),
  bio: text("bio"),
  languagesSpoken: text("languages_spoken").array(),
  yearsExperience: integer("years_experience"),
  consultationFeeXaf: integer("consultation_fee_xaf"),
  cmcNumberEncrypted: text("cmc_number_encrypted"),
  cmcNumberHmac: text("cmc_number_hmac").unique(),
  nicNumberEncrypted: text("nic_number_encrypted"),
  nicNumberHmac: text("nic_number_hmac").unique(),
  cmcCertificateFileKey: text("cmc_certificate_file_key"),
  nicFileKey: text("nic_file_key"),
  profilePhotoFileKey: text("profile_photo_file_key"),
  verificationStatus: verificationStatusEnum("verification_status").notNull().default("incomplete"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
