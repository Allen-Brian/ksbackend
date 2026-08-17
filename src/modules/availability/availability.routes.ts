import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { Effect } from "effect";
import type { AvailabilitySlot } from "@/domain/availability/availability";
import type { AppEnv, AppRuntime } from "@/http/app-env";
import { makeRun } from "@/http/run";
import { CursorQuery, ErrorResponse } from "@/http/schemas";
import { CurrentUser } from "@/infra/auth";
import { CreateSlotBody, SlotResponse, SlotsPage } from "./availability.contract";
import { AvailabilityService } from "./availability.service";

const jsonBody = <T>(schema: T) => ({ content: { "application/json": { schema } } });

const toResponse = (s: AvailabilitySlot) => ({
  id: s.id,
  startsAt: s.startsAt.toISOString(),
  endsAt: s.endsAt.toISOString(),
  status: s.status,
});

const create = createRoute({
  method: "post",
  path: "/v1/practitioners/me/availability",
  tags: ["Availability"],
  summary: "Publish an availability slot",
  description: [
    "The signed-in practitioner publishes a bookable time slot. Requires the `doctor`/`nurse` role",
    "(`403` otherwise) and an existing practitioner profile (`404`). `startsAt` must be in the",
    "future and `endsAt` after it (`422` otherwise); a slot overlapping an existing active one is",
    "`409`. Patients reserving slots is a later story — this only publishes availability.",
  ].join(" "),
  request: { body: jsonBody(CreateSlotBody) },
  responses: {
    201: { ...jsonBody(SlotResponse), description: "The published slot." },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    403: { ...jsonBody(ErrorResponse), description: "Caller is not a practitioner." },
    404: { ...jsonBody(ErrorResponse), description: "The signed-in user isn't a practitioner." },
    409: { ...jsonBody(ErrorResponse), description: "The slot overlaps an existing one." },
    422: { ...jsonBody(ErrorResponse), description: "Invalid times (past start, or end ≤ start)." },
  },
});

const list = createRoute({
  method: "get",
  path: "/v1/practitioners/me/availability",
  tags: ["Availability"],
  summary: "List your published slots",
  description:
    "A cursor-paginated list of the signed-in practitioner's active (non-cancelled) slots.",
  request: { query: CursorQuery },
  responses: {
    200: { ...jsonBody(SlotsPage), description: "A page of your slots." },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    403: { ...jsonBody(ErrorResponse), description: "Caller is not a practitioner." },
    404: { ...jsonBody(ErrorResponse), description: "The signed-in user isn't a practitioner." },
  },
});

const remove = createRoute({
  method: "delete",
  path: "/v1/practitioners/me/availability/{slotId}",
  tags: ["Availability"],
  summary: "Cancel one of your slots",
  description: "Cancels (soft-deletes) a slot you own. `404` if it doesn't exist or isn't yours.",
  request: {
    params: z.object({
      slotId: z.uuid().openapi({ description: "The slot id to cancel." }),
    }),
  },
  responses: {
    204: { description: "The slot was cancelled (no body)." },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    403: { ...jsonBody(ErrorResponse), description: "Caller is not a practitioner." },
    404: { ...jsonBody(ErrorResponse), description: "No such slot owned by the caller." },
  },
});

export const registerAvailabilityRoutes = (app: OpenAPIHono<AppEnv>, runtime: AppRuntime): void => {
  const { runAuth } = makeRun(runtime);

  app.openapi(create, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* AvailabilityService;
        const body = c.req.valid("json");
        const slot = yield* service.createSlot(user.id, {
          startsAt: new Date(body.startsAt),
          endsAt: new Date(body.endsAt),
        });
        return c.json(toResponse(slot), 201);
      }),
    ),
  );

  app.openapi(list, (c) => {
    const { limit, cursor } = c.req.valid("query");
    return runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* AvailabilityService;
        const page = yield* service.listMine(user.id, limit, cursor);
        return c.json({ data: page.data.map(toResponse), meta: page.meta }, 200);
      }),
    );
  });

  app.openapi(remove, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* AvailabilityService;
        yield* service.deleteSlot(user.id, c.req.valid("param").slotId);
        return c.body(null, 204);
      }),
    ),
  );
};
