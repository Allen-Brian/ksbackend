import { z } from "@hono/zod-openapi";

const phone = z
  .string()
  .regex(/^\+[1-9]\d{6,14}$/, "Phone must be E.164, e.g. +237650000000")
  .optional();

export const RegisterPractitionerBody = z
  .object({
    role: z.enum(["doctor", "nurse"]),
    professionId: z.uuid(),
    prefix: z.string().max(20).optional(),
    surname: z.string().min(1).max(120),
    givenNames: z.string().min(1).max(120),
    phone,
    dateOfBirth: z.iso.date().optional(),
    sex: z.enum(["male", "female"]).optional(),
    location: z.string().max(200).optional(),
    consentVersion: z.string().min(1).max(20),
    acceptTerms: z.literal(true),
  })
  .openapi("RegisterPractitioner");

export const PresignDocumentBody = z
  .object({
    kind: z.enum(["cmc-certificate", "nic", "profile-photo"]),
    contentType: z.string().min(1).max(100),
  })
  .openapi("PresignDocument");

export const PresignDocumentResponse = z
  .object({ url: z.string(), key: z.string() })
  .openapi("PresignedUpload");

export const SubmitCredentialsBody = z
  .object({
    cmcRegistrationNumber: z.string().min(3).max(60),
    nicNumber: z.string().min(3).max(60),
    cmcCertificateFileKey: z.string().min(1),
    nicFileKey: z.string().min(1),
    profilePhotoFileKey: z.string().min(1),
  })
  .openapi("SubmitCredentials");

export const PractitionerResponse = z
  .object({
    id: z.uuid(),
    userId: z.string(),
    professionId: z.uuid(),
    prefix: z.string().nullable(),
    surname: z.string(),
    givenNames: z.string(),
    phone: z.string().nullable(),
    dateOfBirth: z.string().nullable(),
    sex: z.enum(["male", "female"]).nullable(),
    location: z.string().nullable(),
    verificationStatus: z.enum(["incomplete", "pending_verification", "verified", "rejected"]),
  })
  .openapi("Practitioner");
