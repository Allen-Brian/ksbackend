export type Sex = "male" | "female";

/** A patient's profile (distinct from the account/`user`). */
export type Patient = {
  readonly id: string;
  readonly userId: string;
  readonly surname: string;
  readonly givenNames: string;
  readonly phone: string | null;
  readonly dateOfBirth: string;
  readonly sex: Sex;
  readonly consentAcceptedAt: Date;
  readonly consentVersion: string;
};

/** Fields a patient submits to complete their profile. */
export type PatientProfileInput = {
  readonly surname: string;
  readonly givenNames: string;
  readonly phone?: string | undefined;
  readonly dateOfBirth: string;
  readonly sex: Sex;
  readonly consentVersion: string;
};
