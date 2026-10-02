import { z } from "zod";

export const DeliverySnapshot = z.object({
  appointmentId: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  event: z.enum(["confirmed", "cancelled", "rescheduled", "reminder"]),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  timezone: z
    .string()
    .max(100)
    .refine(
      (value) => value === "UTC" || Intl.supportedValuesOf("timeZone").includes(value),
      "Invalid timezone",
    ),
  consultationType: z.string().max(40),
  previousStartsAt: z.string().datetime().optional(),
  reminderOffset: z.number().int().positive().optional(),
  pushSubscription: z
    .object({
      id: z.string().uuid(),
      userId: z.string().max(256),
      endpoint: z.string().url().max(4096),
      keys: z.object({ p256dh: z.string().max(1024), auth: z.string().max(1024) }),
    })
    .optional(),
});
export type DeliverySnapshot = z.infer<typeof DeliverySnapshot>;

export const FrozenDelivery = z.object({
  to: z.string().max(4096),
  subject: z.string().max(1000),
  html: z.string().max(100000),
  text: z.string().max(10000),
});
export type FrozenDelivery = z.infer<typeof FrozenDelivery>;
