import { OpenAPIHono } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import { Cause, Effect, Exit } from "effect";
import { evlog } from "evlog/hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { ValidationFailed } from "@/domain/shared/errors";
import { type AuthInstance, type AuthUser, parseRoles } from "@/infra/auth";
import { Health } from "@/infra/health";
import { type Locale, negotiateLocale, translate } from "@/infra/i18n";
import { RateLimiter } from "@/infra/rate-limiter";
import { registerAdminRoutes } from "@/modules/admin/admin.routes";
import { registerDependentRoutes } from "@/modules/dependent/dependent.routes";
import { registerInvitationRoutes } from "@/modules/invitation/invitation.routes";
import { registerPatientRoutes } from "@/modules/patient/patient.routes";
import { registerPractitionerRoutes } from "@/modules/practitioner/practitioner.routes";
import { registerNotificationRoutes } from "@/modules/notification/notification.routes";
import { registerProfileRoutes } from "@/modules/profile/profile.routes";
import type { AppEnv, AppRuntime } from "./app-env";
import { toErrorResponse } from "./error-mapper";
import { registerMeRoute } from "./me.routes";

let ready = true;

/** Toggle readiness. Used by the graceful-shutdown handler in server.ts. */
export const setReady = (value: boolean): void => {
  ready = value;
};

export type CreateAppOptions = {
  readonly corsOrigins?: ReadonlyArray<string>;
  readonly defaultLocale?: Locale;
};

export const createApp = (
  runtime: AppRuntime,
  auth: AuthInstance,
  options: CreateAppOptions = {},
): OpenAPIHono<AppEnv> => {
  const corsOrigins = [...(options.corsOrigins ?? ["http://localhost:3000"])];
  const defaultLocale: Locale = options.defaultLocale ?? "fr";

  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        const issues = result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        }));
        return toErrorResponse(c, Cause.fail(new ValidationFailed({ issues })));
      }
      return undefined;
    },
  });

  // Cross-cutting middleware (order matters): request id → wide-event log →
  // secure headers → CORS → body limit → locale → rate limit → session.
  app.use("*", requestId());
  app.use("*", evlog());
  app.use("*", secureHeaders());
  app.use(
    "*",
    cors({
      origin: corsOrigins,
      credentials: true,
      allowHeaders: ["Content-Type", "Authorization"],
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      maxAge: 600,
    }),
  );
  app.use(
    "*",
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: (c) =>
        c.json(
          {
            error: {
              code: "PAYLOAD_TOO_LARGE",
              message: translate(c.get("locale") ?? defaultLocale, "errors.PAYLOAD_TOO_LARGE"),
              details: [],
            },
            requestId: c.get("requestId"),
          },
          413,
        ),
    }),
  );

  app.use("*", async (c, next) => {
    c.set("locale", negotiateLocale(c.req.header("accept-language"), defaultLocale));
    await next();
  });

  app.use("*", async (c, next) => {
    if (c.req.path === "/livez" || c.req.path === "/readyz") {
      await next();
      return;
    }
    const key = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
    const exit = await runtime.runPromiseExit(
      Effect.flatMap(RateLimiter, (limiter) => limiter.consume(key)),
    );
    const decision = Exit.isSuccess(exit) ? exit.value : ({ allowed: true } as const);
    if (!decision.allowed) {
      c.header("Retry-After", String(decision.retryAfterSeconds));
      return c.json(
        {
          error: {
            code: "RATE_LIMITED",
            message: translate(c.get("locale"), "errors.RATE_LIMITED"),
            details: [],
          },
          requestId: c.get("requestId"),
        },
        429,
      );
    }
    await next();
    return;
  });

  // Resolve the session → attach the user (roles + locale) to the request.
  app.use("*", async (c, next) => {
    let user: AuthUser | null = null;
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (session?.user) {
      const found = session.user;
      user = {
        id: found.id,
        email: found.email,
        name: found.name,
        roles: parseRoles(found.role),
        locale: found.locale === "en" || found.locale === "fr" ? found.locale : defaultLocale,
      };
    }
    c.set("user", user);
    await next();
  });

  // better-auth owns everything under /api/auth/* (mounted OUTSIDE Effect).
  app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  app.get("/livez", (c) => c.json({ status: "ok" } as const));
  app.get("/readyz", async (c) => {
    if (!ready) {
      return c.json({ status: "unavailable" } as const, 503);
    }
    const exit = await runtime.runPromiseExit(Effect.flatMap(Health, (health) => health.ready));
    const ok = Exit.isSuccess(exit) && exit.value;
    return ok ? c.json({ status: "ok" } as const) : c.json({ status: "unavailable" } as const, 503);
  });

  registerMeRoute(app, runtime);
  registerProfileRoutes(app, runtime);
  registerNotificationRoutes(app, runtime);
  registerPatientRoutes(app, runtime);
  registerPractitionerRoutes(app, runtime);
  registerAdminRoutes(app, runtime);
  registerDependentRoutes(app, runtime);
  registerInvitationRoutes(app, runtime);

  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: { title: "kanasante API", version: "0.0.0" },
  });
  app.get("/docs", Scalar({ url: "/openapi.json" }));

  app.notFound((c) =>
    c.json(
      {
        error: {
          code: "NOT_FOUND",
          message: translate(c.get("locale") ?? defaultLocale, "errors.ROUTE_NOT_FOUND"),
          details: [],
        },
        requestId: c.get("requestId"),
      },
      404,
    ),
  );
  app.onError((error, c) => toErrorResponse(c, Cause.fail(error)));

  return app;
};
