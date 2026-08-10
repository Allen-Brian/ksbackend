import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { Effect } from "effect";
import type { NotificationPreference } from "@/domain/notification/notification";
import type { AppEnv, AppRuntime } from "@/http/app-env";
import { makeRun } from "@/http/run";
import { ErrorResponse } from "@/http/schemas";
import { CurrentUser } from "@/infra/auth";
import {
  NotificationPreferencesResponse,
  UpdateNotificationPreferencesBody,
} from "./notification.contract";
import { NotificationService } from "./notification.service";

const jsonBody = <T>(schema: T) => ({ content: { "application/json": { schema } } });

const toResponse = (preferences: ReadonlyArray<NotificationPreference>) => ({
  preferences: preferences.map((p) => ({
    category: p.category,
    email: p.email,
    sms: p.sms,
    push: p.push,
  })),
});

const get = createRoute({
  method: "get",
  path: "/v1/me/notifications",
  tags: ["Profile"],
  summary: "Get the current user's notification preferences (all categories)",
  responses: {
    200: { ...jsonBody(NotificationPreferencesResponse), description: "Preferences" },
    401: { ...jsonBody(ErrorResponse), description: "Not authenticated" },
  },
});

const update = createRoute({
  method: "patch",
  path: "/v1/me/notifications",
  tags: ["Profile"],
  summary: "Update notification preferences for one or more categories",
  request: { body: jsonBody(UpdateNotificationPreferencesBody) },
  responses: {
    200: { ...jsonBody(NotificationPreferencesResponse), description: "Updated preferences" },
    401: { ...jsonBody(ErrorResponse), description: "Not authenticated" },
    422: { ...jsonBody(ErrorResponse), description: "Validation failed" },
  },
});

export const registerNotificationRoutes = (app: OpenAPIHono<AppEnv>, runtime: AppRuntime): void => {
  const { runAuth } = makeRun(runtime);

  app.openapi(get, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* NotificationService;
        return c.json(toResponse(yield* service.get(user.id)), 200);
      }),
    ),
  );

  app.openapi(update, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* NotificationService;
        const updated = yield* service.update(user.id, c.req.valid("json").preferences);
        return c.json(toResponse(updated), 200);
      }),
    ),
  );
};
