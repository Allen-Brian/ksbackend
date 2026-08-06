export type Sex = "male" | "female";

export type VerificationStatus = "incomplete" | "pending_verification" | "verified" | "rejected";

/** A practitioner profile as exposed to the practitioner themselves (no secrets). */
export type Practitioner = {
  readonly id: string;
  readonly userId: string;
  readonly professionId: string;
  readonly prefix: string | null;
  readonly surname: string;
  readonly givenNames: string;
  readonly phone: string | null;
  readonly dateOfBirth: string | null;
  readonly sex: Sex | null;
  readonly location: string | null;
  readonly cmcCertificateFileKey: string | null;
  readonly nicFileKey: string | null;
  readonly profilePhotoFileKey: string | null;
  readonly verificationStatus: VerificationStatus;
};

export type PractitionerRegistration = {
  readonly professionId: string;
  readonly prefix?: string | undefined;
  readonly surname: string;
  readonly givenNames: string;
  readonly phone?: string | undefined;
  readonly dateOfBirth?: string | undefined;
  readonly sex?: Sex | undefined;
  readonly location?: string | undefined;
  readonly consentVersion: string;
};

export type CredentialSubmission = {
  readonly cmcRegistrationNumber: string;
  readonly nicNumber: string;
  readonly cmcCertificateFileKey: string;
  readonly nicFileKey: string;
  readonly profilePhotoFileKey: string;
};
