import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { Effect } from "effect";
import type { Practitioner } from "@/domain/practitioner/practitioner";
import type { AppEnv, AppRuntime } from "@/http/app-env";
import { makeRun } from "@/http/run";
import { CursorQuery, ErrorResponse } from "@/http/schemas";
import { AdminService } from "./admin.service";
import {
  PendingVerificationsResponse,
  RejectBody,
  VerificationDetailResponse,
} from "./admin.contract";

const jsonBody = <T>(schema: T) => ({ content: { "application/json": { schema } } });
const IdParam = z.object({ id: z.uuid() });

const toResponse = (p: Practitioner) => ({
  id: p.id,
  userId: p.userId,
  professionId: p.professionId,
  prefix: p.prefix,
  surname: p.surname,
  givenNames: p.givenNames,
  phone: p.phone,
  dateOfBirth: p.dateOfBirth,
  sex: p.sex,
  location: p.location,
  specialty: p.specialty,
  bio: p.bio,
  languagesSpoken: p.languagesSpoken === null ? null : [...p.languagesSpoken],
  yearsExperience: p.yearsExperience,
  consultationFeeXaf: p.consultationFeeXaf,
  verificationStatus: p.verificationStatus,
});

const list = createRoute({
  method: "get",
  path: "/v1/admin/verifications",
  tags: ["Admin"],
  summary: "List practitioners pending verification",
  request: { query: CursorQuery },
  responses: {
    200: {
      ...jsonBody(PendingVerificationsResponse),
      description: "A page of pending practitioners",
    },
    401: { ...jsonBody(ErrorResponse), description: "Not authenticated" },
    403: { ...jsonBody(ErrorResponse), description: "Not an admin" },
  },
});

const detail = createRoute({
  method: "get",
  path: "/v1/admin/verifications/{id}",
  tags: ["Admin"],
  summary: "Review a practitioner's submitted credentials",
  request: { params: IdParam },
  responses: {
    200: { ...jsonBody(VerificationDetailResponse), description: "Submission detail" },
    401: { ...jsonBody(ErrorResponse), description: "Not authenticated" },
    403: { ...jsonBody(ErrorResponse), description: "Not an admin" },
    404: { ...jsonBody(ErrorResponse), description: "Not found" },
  },
});

const approve = createRoute({
  method: "post",
  path: "/v1/admin/verifications/{id}/approve",
  tags: ["Admin"],
  summary: "Approve a practitioner",
  request: { params: IdParam },
  responses: {
    200: { ...jsonBody(VerificationDetailResponse.shape.practitioner), description: "Approved" },
    401: { ...jsonBody(ErrorResponse), description: "Not authenticated" },
    403: { ...jsonBody(ErrorResponse), description: "Not an admin" },
    404: { ...jsonBody(ErrorResponse), description: "Not found" },
  },
});

const reject = createRoute({
  method: "post",
  path: "/v1/admin/verifications/{id}/reject",
  tags: ["Admin"],
  summary: "Reject a practitioner with a reason",
  request: { params: IdParam, body: jsonBody(RejectBody) },
  responses: {
    200: { ...jsonBody(VerificationDetailResponse.shape.practitioner), description: "Rejected" },
    401: { ...jsonBody(ErrorResponse), description: "Not authenticated" },
    403: { ...jsonBody(ErrorResponse), description: "Not an admin" },
    404: { ...jsonBody(ErrorResponse), description: "Not found" },
    422: { ...jsonBody(ErrorResponse), description: "Validation failed" },
  },
});

export const registerAdminRoutes = (app: OpenAPIHono<AppEnv>, runtime: AppRuntime): void => {
  const { runAuth } = makeRun(runtime);

  app.openapi(list, (c) => {
    const { limit, cursor } = c.req.valid("query");
    return runAuth(
      c,
      Effect.gen(function* () {
        const service = yield* AdminService;
        const page = yield* service.listPending(limit, cursor);
        return c.json({ data: page.data.map(toResponse), meta: page.meta }, 200);
      }),
    );
  });

  app.openapi(detail, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const service = yield* AdminService;
        const result = yield* service.getDetail(c.req.valid("param").id);
        return c.json(
          {
            practitioner: toResponse(result.practitioner),
            cmcRegistrationNumber: result.cmcRegistrationNumber,
            nicNumber: result.nicNumber,
            documents: result.documents,
          },
          200,
        );
      }),
    ),
  );

  app.openapi(approve, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const service = yield* AdminService;
        const updated = yield* service.approve(c.req.valid("param").id);
        return c.json(toResponse(updated), 200);
      }),
    ),
  );

  app.openapi(reject, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const service = yield* AdminService;
        const updated = yield* service.reject(c.req.valid("param").id, c.req.valid("json").reason);
        return c.json(toResponse(updated), 200);
      }),
    ),
  );
};
