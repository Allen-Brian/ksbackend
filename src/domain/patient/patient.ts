import type { Profile, Sex } from "@/domain/profile/profile";

/** Who to contact in an emergency for a patient. */
export type EmergencyContact = {
  readonly name: string;
  readonly phone: string;
  readonly relationship: string;
};

/**
 * A patient: the base `Profile` plus patient-specific data (emergency contact).
 * Identity/contact/consent live on the base profile.
 */
export type Patient = Profile & {
  readonly emergencyContact: EmergencyContact | null;
};

/** Fields a patient submits to complete their profile (base + patient-specific). */
export type PatientProfileInput = {
  readonly surname: string;
  readonly givenNames: string;
  readonly phone?: string | undefined;
  readonly dateOfBirth: string;
  readonly sex: Sex;
  readonly consentVersion: string;
  /** Omitted (`undefined`) leaves any stored contact untouched. */
  readonly emergencyContact?: EmergencyContact | undefined;
};

/**
 * Partial edit of the patient-specific data without re-accepting terms.
 * `emergencyContact`: an object replaces, `null` clears, `undefined` leaves it as-is.
 */
export type PatientProfilePatch = {
  readonly emergencyContact?: EmergencyContact | null | undefined;
};
