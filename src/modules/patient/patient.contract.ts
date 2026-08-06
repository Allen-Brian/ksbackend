import { z } from "@hono/zod-openapi";

const phone = z
  .string()
  .regex(/^\+[1-9]\d{6,14}$/, "Phone must be E.164, e.g. +237650000000")
  .optional();

export const CompletePatientProfileBody = z
  .object({
    surname: z.string().min(1).max(120),
    givenNames: z.string().min(1).max(120),
    phone,
    dateOfBirth: z.iso.date(),
    sex: z.enum(["male", "female"]),
    consentVersion: z.string().min(1).max(20),
    acceptTerms: z.literal(true),
  })
  .openapi("CompletePatientProfile");

export const PatientProfileResponse = z
  .object({
    id: z.uuid(),
    userId: z.string(),
    surname: z.string(),
    givenNames: z.string(),
    phone: z.string().nullable(),
    dateOfBirth: z.string(),
    sex: z.enum(["male", "female"]),
  })
  .openapi("PatientProfile");
