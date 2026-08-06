import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { Effect } from "effect";
import { CurrentUser } from "@/infra/auth";
import type { AppEnv, AppRuntime } from "./app-env";
import { makeRun } from "./run";
import { ErrorResponse } from "./schemas";

const MeResponse = z
  .object({
    id: z.string(),
    email: z.email(),
    name: z.string(),
    roles: z.array(z.string()),
    locale: z.string(),
  })
  .openapi("Me");

const jsonBody = <T>(schema: T) => ({ content: { "application/json": { schema } } });

const me = createRoute({
  method: "get",
  path: "/v1/me",
  tags: ["Account"],
  summary: "The currently authenticated user",
  responses: {
    200: { ...jsonBody(MeResponse), description: "The current user" },
    401: { ...jsonBody(ErrorResponse), description: "Not authenticated" },
  },
});

/** `GET /v1/me` — identity + roles for the signed-in user (profile lives per-module). */
export const registerMeRoute = (app: OpenAPIHono<AppEnv>, runtime: AppRuntime): void => {
  const { runAuth } = makeRun(runtime);

  app.openapi(me, (c) =>
    runAuth(
      c,
      Effect.map(CurrentUser, (current) =>
        c.json(
          {
            id: current.id,
            email: current.email,
            name: current.name,
            roles: [...current.roles],
            locale: current.locale,
          },
          200,
        ),
      ),
    ),
  );
};
