import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { Effect } from "effect";
import type { Practitioner } from "@/domain/practitioner/practitioner";
import type { AppEnv, AppRuntime } from "@/http/app-env";
import { makeRun } from "@/http/run";
import { ErrorResponse } from "@/http/schemas";
import { CurrentUser } from "@/infra/auth";
import {
  PractitionerResponse,
  PresignDocumentBody,
  PresignDocumentResponse,
  PublicPractitionerResponse,
  RegisterPractitionerBody,
  SubmitCredentialsBody,
  UpdatePublicProfileBody,
} from "./practitioner.contract";
import { PractitionerService } from "./practitioner.service";

const jsonBody = <T>(schema: T) => ({ content: { "application/json": { schema } } });

const publicFields = (p: Practitioner) => ({
  specialty: p.specialty,
  bio: p.bio,
  languagesSpoken: p.languagesSpoken === null ? null : [...p.languagesSpoken],
  yearsExperience: p.yearsExperience,
  consultationFeeXaf: p.consultationFeeXaf,
});

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
  ...publicFields(p),
  verificationStatus: p.verificationStatus,
});

const toPublicResponse = (p: Practitioner, photoUrl: string | null) => ({
  id: p.id,
  professionId: p.professionId,
  prefix: p.prefix,
  surname: p.surname,
  givenNames: p.givenNames,
  location: p.location,
  ...publicFields(p),
  photoUrl,
});

const register = createRoute({
  method: "post",
  path: "/v1/practitioners/register",
  tags: ["Practitioners"],
  summary: "Register the current user as a practitioner",
  request: { body: jsonBody(RegisterPractitionerBody) },
  responses: {
    201: { ...jsonBody(PractitionerResponse), description: "Registered (incomplete)" },
    401: { ...jsonBody(ErrorResponse), description: "Not authenticated" },
    422: { ...jsonBody(ErrorResponse), description: "Validation failed" },
  },
});

const presign = createRoute({
  method: "post",
  path: "/v1/practitioners/me/documents/presign",
  tags: ["Practitioners"],
  summary: "Get a presigned URL to upload a verification document",
  request: { body: jsonBody(PresignDocumentBody) },
  responses: {
    200: { ...jsonBody(PresignDocumentResponse), description: "Presigned upload" },
    401: { ...jsonBody(ErrorResponse), description: "Not authenticated" },
    422: { ...jsonBody(ErrorResponse), description: "Unsupported content type" },
  },
});

const submit = createRoute({
  method: "post",
  path: "/v1/practitioners/me/credentials",
  tags: ["Practitioners"],
  summary: "Submit credentials for verification",
  request: { body: jsonBody(SubmitCredentialsBody) },
  responses: {
    200: { ...jsonBody(PractitionerResponse), description: "Submitted for verification" },
    401: { ...jsonBody(ErrorResponse), description: "Not authenticated" },
    409: {
      ...jsonBody(ErrorResponse),
      description: "Licence already registered / profile incomplete",
    },
    422: { ...jsonBody(ErrorResponse), description: "A file failed the security scan" },
  },
});

const getMine = createRoute({
  method: "get",
  path: "/v1/practitioners/me",
  tags: ["Practitioners"],
  summary: "Get the current practitioner profile + verification status",
  responses: {
    200: { ...jsonBody(PractitionerResponse), description: "The profile" },
    401: { ...jsonBody(ErrorResponse), description: "Not authenticated" },
    404: { ...jsonBody(ErrorResponse), description: "Not a practitioner" },
  },
});

const updatePublic = createRoute({
  method: "patch",
  path: "/v1/practitioners/me",
  tags: ["Practitioners"],
  summary: "Update the current practitioner's public/bookable profile",
  request: { body: jsonBody(UpdatePublicProfileBody) },
  responses: {
    200: { ...jsonBody(PractitionerResponse), description: "Updated" },
    401: { ...jsonBody(ErrorResponse), description: "Not authenticated" },
    404: { ...jsonBody(ErrorResponse), description: "Not a practitioner" },
    422: { ...jsonBody(ErrorResponse), description: "Validation failed" },
  },
});

const getPublic = createRoute({
  method: "get",
  path: "/v1/practitioners/{id}",
  tags: ["Practitioners"],
  summary: "Get a verified practitioner's public profile",
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: { ...jsonBody(PublicPractitionerResponse), description: "The public profile" },
    401: { ...jsonBody(ErrorResponse), description: "Not authenticated" },
    404: { ...jsonBody(ErrorResponse), description: "Not found or not verified" },
  },
});

export const registerPractitionerRoutes = (app: OpenAPIHono<AppEnv>, runtime: AppRuntime): void => {
  const { runAuth } = makeRun(runtime);

  app.openapi(register, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* PractitionerService;
        const body = c.req.valid("json");
        const created = yield* service.register(user.id, body.role, {
          professionId: body.professionId,
          prefix: body.prefix,
          surname: body.surname,
          givenNames: body.givenNames,
          phone: body.phone,
          dateOfBirth: body.dateOfBirth,
          sex: body.sex,
          location: body.location,
          consentVersion: body.consentVersion,
        });
        return c.json(toResponse(created), 201);
      }),
    ),
  );

  app.openapi(presign, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* PractitionerService;
        const body = c.req.valid("json");
        const result = yield* service.presignDocument(user.id, body.kind, body.contentType);
        return c.json(result, 200);
      }),
    ),
  );

  app.openapi(submit, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* PractitionerService;
        const updated = yield* service.submitCredentials(user.id, c.req.valid("json"));
        return c.json(toResponse(updated), 200);
      }),
    ),
  );

  app.openapi(getMine, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* PractitionerService;
        const found = yield* service.getMine(user.id);
        return c.json(toResponse(found), 200);
      }),
    ),
  );

  app.openapi(updatePublic, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* PractitionerService;
        const updated = yield* service.updatePublicProfile(user.id, c.req.valid("json"));
        return c.json(toResponse(updated), 200);
      }),
    ),
  );

  app.openapi(getPublic, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const service = yield* PractitionerService;
        const { practitioner, photoUrl } = yield* service.getPublic(c.req.valid("param").id);
        return c.json(toPublicResponse(practitioner, photoUrl), 200);
      }),
    ),
  );
};
