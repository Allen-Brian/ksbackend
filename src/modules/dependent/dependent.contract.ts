import { z } from "@hono/zod-openapi";
import { paginated } from "@/http/schemas";

const phone = z
  .string()
  .regex(/^\+[1-9]\d{6,14}$/, "Phone must be E.164, e.g. +237650000000")
  .optional()
  .openapi({
    description: "E.164 phone number for the dependent (optional).",
    example: "+237650000000",
  });

const sex = z
  .enum(["male", "female"])
  .openapi({ description: "The dependent's sex.", example: "female" });

const relationship = z.enum(["child", "parent", "spouse", "sibling", "other"]).openapi({
  description:
    "How THIS caregiver relates to the dependent. Stored per-caregiver, so the same dependent may be a `child` to one caregiver and a `sibling` to another.",
  example: "child",
});

/** Request-side emergency contact: someone local to the dependent, reachable in an emergency. */
const EmergencyContactInput = z.object({
  name: z
    .string()
    .min(1)
    .max(120)
    .openapi({ description: "Full name of the emergency contact.", example: "Mama Nkeng" }),
  phone: z
    .string()
    .regex(/^\+[1-9]\d{6,14}$/, "Phone must be E.164")
    .openapi({
      description: "Emergency contact's phone in E.164 format.",
      example: "+237699000000",
    }),
  relationship: z.string().min(1).max(60).openapi({
    description: "How this contact relates to the dependent.",
    example: "Grandmother",
  }),
});

/** Response-side emergency contact, or null when none is stored. */
const EmergencyContactOutput = z
  .object({
    name: z
      .string()
      .openapi({ description: "Full name of the emergency contact.", example: "Mama Nkeng" }),
    phone: z.string().openapi({
      description: "Emergency contact's phone in E.164.",
      example: "+237699000000",
    }),
    relationship: z.string().openapi({
      description: "How this contact relates to the dependent.",
      example: "Grandmother",
    }),
  })
  .nullable()
  .openapi({ description: "The stored emergency contact, or null if none has been set." });

export const CreateDependentBody = z
  .object({
    surname: z.string().min(1).max(120).openapi({ description: "Family name.", example: "Nkeng" }),
    givenNames: z
      .string()
      .min(1)
      .max(120)
      .openapi({ description: "Given name(s).", example: "Ariane" }),
    dateOfBirth: z.iso
      .date()
      .openapi({ description: "Date of birth (YYYY-MM-DD).", example: "2015-03-02" }),
    sex,
    relationship,
    phone,
    location: z
      .string()
      .max(200)
      .optional()
      .openapi({ description: "Free-text town/region (optional).", example: "Bamenda, Cameroon" }),
    emergencyContact: EmergencyContactInput.optional().openapi({
      description:
        "Who to reach locally in an emergency — the caregiver is often abroad, so this should be someone near the dependent. Optional.",
    }),
  })
  .openapi("CreateDependent");

export const UpdateDependentBody = z
  .object({
    surname: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .openapi({ description: "Family name — updates the dependent person.", example: "Nkeng" }),
    givenNames: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .openapi({ description: "Given name(s) — updates the dependent person.", example: "Ariane" }),
    dateOfBirth: z.iso.date().optional().openapi({
      description: "Date of birth (YYYY-MM-DD) — updates the dependent person.",
      example: "2015-03-02",
    }),
    sex: sex.optional(),
    relationship: relationship.optional().openapi({
      description:
        "Updates only THIS caregiver's link — other caregivers' relationships are untouched.",
      example: "child",
    }),
    phone,
    location: z.string().max(200).optional().openapi({
      description: "Free-text town/region — updates the dependent person.",
      example: "Bamenda, Cameroon",
    }),
    emergencyContact: EmergencyContactInput.nullable().optional().openapi({
      description:
        "Local emergency contact — updates the dependent person. Send an object to replace it, explicit `null` to clear it, or omit the field to leave it untouched.",
    }),
  })
  .openapi("UpdateDependent");

export const DependentResponse = z
  .object({
    id: z.uuid().openapi({
      description: "The dependent person's id.",
      example: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    }),
    surname: z.string().openapi({ description: "Family name.", example: "Nkeng" }),
    givenNames: z.string().openapi({ description: "Given name(s).", example: "Ariane" }),
    dateOfBirth: z
      .string()
      .openapi({ description: "Date of birth (YYYY-MM-DD).", example: "2015-03-02" }),
    sex,
    relationship,
    phone: z
      .string()
      .nullable()
      .openapi({ description: "E.164 phone number, or null.", example: "+237650000000" }),
    location: z
      .string()
      .nullable()
      .openapi({ description: "Free-text town/region, or null.", example: "Bamenda, Cameroon" }),
    emergencyContact: EmergencyContactOutput,
  })
  .openapi("Dependent");

export const DependentsPage = paginated(DependentResponse).openapi("DependentsPage");
