import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { Effect } from "effect";
import type { AppEnv, AppRuntime } from "@/http/app-env";
import { makeRun } from "@/http/run";
import { ErrorResponse } from "@/http/schemas";
import { CurrentUser } from "@/infra/auth";
import {
  RegisterPushSubscriptionBody,
  PushSubscriptionResponse,
  PushPublicKeyResponse,
  PushSubscriptionParams,
} from "./push-subscription.contract";
import { PushSubscriptionService } from "./push-subscription.service";
const jsonBody = <T>(schema: T) => ({ content: { "application/json": { schema } } });
const unauthorized = { ...jsonBody(ErrorResponse), description: "No valid session." };
const key = createRoute({
  method: "get",
  path: "/v1/me/push-subscriptions/public-key",
  tags: ["Notifications"],
  summary: "Get public Web Push VAPID key",
  responses: {
    200: {
      ...jsonBody(PushPublicKeyResponse),
      description: "Whether push is enabled, and public key when available.",
    },
    401: unauthorized,
  },
});
const register = createRoute({
  method: "post",
  path: "/v1/me/push-subscriptions",
  tags: ["Notifications"],
  summary: "Register browser push subscription",
  description:
    "Registering a device does not enable push preferences. Enable the appointments push preference separately.",
  request: { body: jsonBody(RegisterPushSubscriptionBody) },
  responses: {
    200: { ...jsonBody(PushSubscriptionResponse), description: "Registered subscription." },
    401: unauthorized,
    409: {
      ...jsonBody(ErrorResponse),
      description: "Endpoint belongs to another account or subscription limit reached.",
    },
    422: {
      ...jsonBody(ErrorResponse),
      description: "Invalid subscription or unsupported provider.",
    },
  },
});
const remove = createRoute({
  method: "delete",
  path: "/v1/me/push-subscriptions/{id}",
  tags: ["Notifications"],
  summary: "Remove an owned browser push subscription",
  request: { params: PushSubscriptionParams },
  responses: {
    204: { description: "Subscription removed, or no owned subscription exists." },
    401: unauthorized,
    422: { ...jsonBody(ErrorResponse), description: "Invalid subscription id." },
  },
});
export const registerPushSubscriptionRoutes = (
  app: OpenAPIHono<AppEnv>,
  runtime: AppRuntime,
): void => {
  const { runAuth } = makeRun(runtime);
  app.openapi(key, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const service = yield* PushSubscriptionService;
        return c.json(
          {
            enabled: service.publicKey !== "",
            publicKey: service.publicKey === "" ? null : service.publicKey,
          },
          200,
        );
      }),
    ),
  );
  app.openapi(register, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* PushSubscriptionService;
        const result = yield* service.register(user.id, c.req.valid("json"));
        return c.json({ id: result.id, endpoint: result.endpoint, keys: result.keys }, 200);
      }),
    ),
  );
  app.openapi(remove, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* PushSubscriptionService;
        yield* service.remove(user.id, c.req.valid("param").id);
        return c.body(null, 204);
      }),
    ),
  );
};
