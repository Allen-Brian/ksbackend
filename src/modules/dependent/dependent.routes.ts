import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { Effect } from "effect";
import type { Dependent } from "@/domain/dependent/dependent";
import type { AppEnv, AppRuntime } from "@/http/app-env";
import { makeRun } from "@/http/run";
import { CursorQuery, ErrorResponse } from "@/http/schemas";
import { CurrentUser } from "@/infra/auth";
import {
  CreateDependentBody,
  DependentResponse,
  DependentsPage,
  UpdateDependentBody,
} from "./dependent.contract";
import { DependentService } from "./dependent.service";

const jsonBody = <T>(schema: T) => ({ content: { "application/json": { schema } } });
const IdParam = z.object({ id: z.uuid() });

const toResponse = (d: Dependent) => ({
  id: d.id,
  surname: d.surname,
  givenNames: d.givenNames,
  dateOfBirth: d.dateOfBirth,
  sex: d.sex,
  relationship: d.relationship,
  phone: d.phone,
  location: d.location,
});

const create = createRoute({
  method: "post",
  path: "/v1/dependents",
  tags: ["Dependents"],
  summary: "Add a dependent",
  request: { body: jsonBody(CreateDependentBody) },
  responses: {
    201: { ...jsonBody(DependentResponse), description: "Created" },
    401: { ...jsonBody(ErrorResponse), description: "Not authenticated" },
    422: { ...jsonBody(ErrorResponse), description: "Validation failed" },
  },
});

const list = createRoute({
  method: "get",
  path: "/v1/dependents",
  tags: ["Dependents"],
  summary: "List the current user's dependents",
  request: { query: CursorQuery },
  responses: {
    200: { ...jsonBody(DependentsPage), description: "A page of dependents" },
    401: { ...jsonBody(ErrorResponse), description: "Not authenticated" },
  },
});

const getOne = createRoute({
  method: "get",
  path: "/v1/dependents/{id}",
  tags: ["Dependents"],
  summary: "Get a dependent",
  request: { params: IdParam },
  responses: {
    200: { ...jsonBody(DependentResponse), description: "The dependent" },
    401: { ...jsonBody(ErrorResponse), description: "Not authenticated" },
    404: { ...jsonBody(ErrorResponse), description: "Not found" },
  },
});

const update = createRoute({
  method: "patch",
  path: "/v1/dependents/{id}",
  tags: ["Dependents"],
  summary: "Update a dependent",
  request: { params: IdParam, body: jsonBody(UpdateDependentBody) },
  responses: {
    200: { ...jsonBody(DependentResponse), description: "Updated" },
    401: { ...jsonBody(ErrorResponse), description: "Not authenticated" },
    404: { ...jsonBody(ErrorResponse), description: "Not found" },
  },
});

const remove = createRoute({
  method: "delete",
  path: "/v1/dependents/{id}",
  tags: ["Dependents"],
  summary: "Remove a dependent",
  request: { params: IdParam },
  responses: {
    204: { description: "Deleted" },
    401: { ...jsonBody(ErrorResponse), description: "Not authenticated" },
    404: { ...jsonBody(ErrorResponse), description: "Not found" },
  },
});

export const registerDependentRoutes = (app: OpenAPIHono<AppEnv>, runtime: AppRuntime): void => {
  const { runAuth } = makeRun(runtime);

  app.openapi(create, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* DependentService;
        const created = yield* service.create(user.id, c.req.valid("json"));
        return c.json(toResponse(created), 201);
      }),
    ),
  );

  app.openapi(list, (c) => {
    const { limit, cursor } = c.req.valid("query");
    return runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* DependentService;
        const page = yield* service.list(user.id, limit, cursor);
        return c.json({ data: page.data.map(toResponse), meta: page.meta }, 200);
      }),
    );
  });

  app.openapi(getOne, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* DependentService;
        const found = yield* service.get(user.id, c.req.valid("param").id);
        return c.json(toResponse(found), 200);
      }),
    ),
  );

  app.openapi(update, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* DependentService;
        const updated = yield* service.update(
          user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        );
        return c.json(toResponse(updated), 200);
      }),
    ),
  );

  app.openapi(remove, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* DependentService;
        yield* service.remove(user.id, c.req.valid("param").id);
        return c.body(null, 204);
      }),
    ),
  );
};
