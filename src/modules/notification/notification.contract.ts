import { z } from "@hono/zod-openapi";

const preference = z.object({
  category: z.enum(["appointments", "verification", "security", "account"]),
  email: z.boolean(),
  sms: z.boolean(),
  push: z.boolean(),
});

export const NotificationPreferencesResponse = z
  .object({ preferences: z.array(preference) })
  .openapi("NotificationPreferences");

export const UpdateNotificationPreferencesBody = z
  .object({ preferences: z.array(preference).min(1).max(20) })
  .openapi("UpdateNotificationPreferences");
