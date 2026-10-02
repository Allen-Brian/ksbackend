import { z } from "@hono/zod-openapi";
export const RegisterPushSubscriptionBody = z.object({
  endpoint: z.string().url().max(2048),
  keys: z.object({
    p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
    auth: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  }),
});
export const PushSubscriptionResponse = z.object({
  id: z.uuid(),
  endpoint: z.string(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
});
export const PushPublicKeyResponse = z.object({
  enabled: z.boolean(),
  publicKey: z.string().nullable(),
});
export const PushSubscriptionParams = z.object({ id: z.uuid() });
