export type Sex = "male" | "female";

export type VerificationStatus = "incomplete" | "pending_verification" | "verified" | "rejected";

/** How a practitioner offers consultations. */
export const CONSULTATION_TYPES = ["in_person", "video", "home_visit"] as const;
export type ConsultationType = (typeof CONSULTATION_TYPES)[number];

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
  readonly specialty: string | null;
  readonly bio: string | null;
  readonly languagesSpoken: ReadonlyArray<string> | null;
  readonly yearsExperience: number | null;
  readonly consultationFeeXaf: number | null;
  readonly consultationTypes: ReadonlyArray<ConsultationType> | null;
  readonly ratingAverage: number;
  readonly ratingCount: number;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly cmcCertificateFileKey: string | null;
  readonly nicFileKey: string | null;
  readonly profilePhotoFileKey: string | null;
  readonly verificationStatus: VerificationStatus;
};

/** Editable public-profile fields (PATCH /v1/practitioners/me). */
export type PublicProfilePatch = {
  readonly prefix?: string | undefined;
  readonly location?: string | undefined;
  readonly specialty?: string | undefined;
  readonly bio?: string | undefined;
  readonly languagesSpoken?: ReadonlyArray<string> | undefined;
  readonly yearsExperience?: number | undefined;
  readonly consultationFeeXaf?: number | undefined;
  readonly consultationTypes?: ReadonlyArray<ConsultationType> | undefined;
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
