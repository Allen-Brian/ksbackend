import type { Profile, Sex } from "@/domain/profile/profile";

/**
 * A patient. Identity/contact/consent live on the base `Profile`; a patient adds
 * only patient-specific data later (emergency contact). For now `Patient` is the
 * base profile of a user who holds the patient role.
 */
export type Patient = Profile;

/** Fields a patient submits to complete their profile (written to the base profile). */
export type PatientProfileInput = {
  readonly surname: string;
  readonly givenNames: string;
  readonly phone?: string | undefined;
  readonly dateOfBirth: string;
  readonly sex: Sex;
  readonly consentVersion: string;
};
