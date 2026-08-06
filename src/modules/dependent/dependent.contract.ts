import { z } from "@hono/zod-openapi";
import { paginated } from "@/http/schemas";

const phone = z
  .string()
  .regex(/^\+[1-9]\d{6,14}$/, "Phone must be E.164, e.g. +237650000000")
  .optional();

const sex = z.enum(["male", "female"]);
const relationship = z.enum(["child", "parent", "spouse", "sibling", "other"]);

export const CreateDependentBody = z
  .object({
    surname: z.string().min(1).max(120),
    givenNames: z.string().min(1).max(120),
    dateOfBirth: z.iso.date(),
    sex,
    relationship,
    phone,
    location: z.string().max(200).optional(),
  })
  .openapi("CreateDependent");

export const UpdateDependentBody = z
  .object({
    surname: z.string().min(1).max(120).optional(),
    givenNames: z.string().min(1).max(120).optional(),
    dateOfBirth: z.iso.date().optional(),
    sex: sex.optional(),
    relationship: relationship.optional(),
    phone,
    location: z.string().max(200).optional(),
  })
  .openapi("UpdateDependent");

export const DependentResponse = z
  .object({
    id: z.uuid(),
    surname: z.string(),
    givenNames: z.string(),
    dateOfBirth: z.string(),
    sex,
    relationship,
    phone: z.string().nullable(),
    location: z.string().nullable(),
  })
  .openapi("Dependent");

export const DependentsPage = paginated(DependentResponse).openapi("DependentsPage");
