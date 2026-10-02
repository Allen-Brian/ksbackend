import { z } from "@hono/zod-openapi";
export const BookingPolicyBody = z.object({
  cancellationCutoffHours: z.number().int().min(0).max(168).nullable(),
});
export const BookingPolicyResponse = z.object({
  cancellationCutoffHours: z.number().int().nonnegative(),
  overrideCancellationCutoffHours: z.number().int().nonnegative().nullable(),
});
