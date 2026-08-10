import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { Effect } from "effect";
import { CurrentUser } from "@/infra/auth";
import type { AppEnv, AppRuntime } from "./app-env";
import { makeRun } from "./run";
import { ErrorResponse } from "./schemas";

const MeResponse = z
  .object({
    id: z.string().openapi({ description: "The user's id.", example: "usr_9f3c…" }),
    email: z
      .email()
      .openapi({ description: "The account's login email.", example: "ama@example.com" }),
    name: z
      .string()
      .openapi({ description: "Display name captured at sign-up.", example: "Ama Mbeki" }),
    roles: z.array(z.string()).openapi({
      description:
        "Every role the user holds — a user can hold several at once. One of: patient, doctor, nurse, dependent, admin.",
      example: ["patient"],
    }),
    locale: z
      .string()
      .openapi({ description: "Preferred locale for emails/messages.", example: "fr" }),
  })
  .openapi("Me");

const jsonBody = <T>(schema: T) => ({ content: { "application/json": { schema } } });

const me = createRoute({
  method: "get",
  path: "/v1/me",
  tags: ["Account"],
  summary: "The currently authenticated user",
  description: [
    "Identity and roles for the signed-in user — the first call a client should make after",
    "sign-in to learn who the user is and what they can do. Returns only account-level fields;",
    "the editable profile lives at `GET /v1/me/profile`, and role-specific data under each",
    "role's own endpoints (e.g. `/v1/patients/me/profile`, `/v1/practitioners/me`).",
  ].join(" "),
  responses: {
    200: { ...jsonBody(MeResponse), description: "The current user's identity and roles." },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
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
