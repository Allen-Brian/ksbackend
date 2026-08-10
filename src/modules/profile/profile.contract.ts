import { z } from "@hono/zod-openapi";

const phone = z.string().regex(/^\+[1-9]\d{6,14}$/, "Phone must be E.164, e.g. +237650000000");

export const UpdateProfileBody = z
  .object({
    surname: z.string().min(1).max(120).optional(),
    givenNames: z.string().min(1).max(120).optional(),
    phone: phone.nullable().optional(),
    dateOfBirth: z.iso.date().optional(),
    sex: z.enum(["male", "female"]).optional(),
  })
  .openapi("UpdateProfile");

export const ProfileResponse = z
  .object({
    id: z.uuid(),
    userId: z.string(),
    surname: z.string(),
    givenNames: z.string(),
    phone: z.string().nullable(),
    dateOfBirth: z.string().nullable(),
    sex: z.enum(["male", "female"]).nullable(),
  })
  .openapi("Profile");
