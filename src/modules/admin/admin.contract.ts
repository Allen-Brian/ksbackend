import { z } from "@hono/zod-openapi";
import { paginated } from "@/http/schemas";
import { PractitionerResponse } from "@/modules/practitioner/practitioner.contract";

export const PendingVerificationsResponse =
  paginated(PractitionerResponse).openapi("PendingVerifications");

export const VerificationDetailResponse = z
  .object({
    practitioner: PractitionerResponse,
    cmcRegistrationNumber: z.string(),
    nicNumber: z.string(),
    documents: z.object({
      cmcCertificateUrl: z.string().nullable(),
      nicUrl: z.string().nullable(),
      profilePhotoUrl: z.string().nullable(),
    }),
  })
  .openapi("VerificationDetail");

export const RejectBody = z
  .object({ reason: z.string().min(3).max(500) })
  .openapi("RejectVerification");
