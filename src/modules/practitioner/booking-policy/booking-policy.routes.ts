import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { Effect } from "effect";
import type { AppEnv, AppRuntime } from "@/http/app-env";
import { makeRun } from "@/http/run";
import { ErrorResponse } from "@/http/schemas";
import { BookingPolicyBody, BookingPolicyResponse } from "./booking-policy.contract";
import { BookingPolicyService } from "./booking-policy.service";
const jsonBody = <T>(schema: T) => ({
  description: "JSON payload.",
  content: { "application/json": { schema } },
});
const responses = {
  200: jsonBody(BookingPolicyResponse),
  401: jsonBody(ErrorResponse),
  403: jsonBody(ErrorResponse),
  404: jsonBody(ErrorResponse),
  422: jsonBody(ErrorResponse),
};
const get = createRoute({
  method: "get",
  path: "/v1/practitioners/me/booking-policy",
  tags: ["Booking policy"],
  responses,
});
const update = createRoute({
  method: "patch",
  path: "/v1/practitioners/me/booking-policy",
  tags: ["Booking policy"],
  request: { body: jsonBody(BookingPolicyBody) },
  responses,
});
const publicGet = createRoute({
  method: "get",
  path: "/v1/practitioners/{id}/booking-policy",
  tags: ["Booking policy"],
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: jsonBody(z.object({ cancellationCutoffHours: z.number().int().nonnegative() })),
    404: jsonBody(ErrorResponse),
    401: jsonBody(ErrorResponse),
  },
});
export const registerBookingPolicyRoutes = (
  app: OpenAPIHono<AppEnv>,
  runtime: AppRuntime,
): void => {
  const { runAuth } = makeRun(runtime);
  app.openapi(publicGet, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const service = yield* BookingPolicyService;
        return c.json(yield* service.getPublic(c.req.valid("param").id), 200);
      }),
    ),
  );
  app.openapi(get, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const service = yield* BookingPolicyService;
        return c.json(yield* service.getMine(), 200);
      }),
    ),
  );
  app.openapi(update, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const service = yield* BookingPolicyService;
        return c.json(yield* service.updateMine(c.req.valid("json").cancellationCutoffHours), 200);
      }),
    ),
  );
};
