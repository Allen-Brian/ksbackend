import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { Effect } from "effect";
import type { Profile } from "@/domain/profile/profile";
import type { AppEnv, AppRuntime } from "@/http/app-env";
import { makeRun } from "@/http/run";
import { ErrorResponse } from "@/http/schemas";
import { CurrentUser } from "@/infra/auth";
import {
  AvatarPresignBody,
  AvatarPresignResponse,
  ProfileResponse,
  UpdateProfileBody,
} from "./profile.contract";
import { ProfileService } from "./profile.service";

const jsonBody = <T>(schema: T) => ({ content: { "application/json": { schema } } });

const toResponse = (p: Profile) => ({
  id: p.id,
  userId: p.userId,
  surname: p.surname,
  givenNames: p.givenNames,
  phone: p.phone,
  dateOfBirth: p.dateOfBirth,
  sex: p.sex,
  avatarFileKey: p.avatarFileKey,
});

const getProfile = createRoute({
  method: "get",
  path: "/v1/me/profile",
  tags: ["Profile"],
  summary: "Get the current user's base profile",
  responses: {
    200: { ...jsonBody(ProfileResponse), description: "The base profile" },
    401: { ...jsonBody(ErrorResponse), description: "Not authenticated" },
    404: { ...jsonBody(ErrorResponse), description: "No profile yet" },
  },
});

const updateProfile = createRoute({
  method: "patch",
  path: "/v1/me/profile",
  tags: ["Profile"],
  summary: "Update the current user's base profile",
  request: { body: jsonBody(UpdateProfileBody) },
  responses: {
    200: { ...jsonBody(ProfileResponse), description: "Updated" },
    401: { ...jsonBody(ErrorResponse), description: "Not authenticated" },
    404: { ...jsonBody(ErrorResponse), description: "No profile yet" },
    422: { ...jsonBody(ErrorResponse), description: "Validation failed" },
  },
});

const presignAvatar = createRoute({
  method: "post",
  path: "/v1/me/avatar/presign",
  tags: ["Profile"],
  summary: "Get a presigned URL to upload a profile avatar",
  request: { body: jsonBody(AvatarPresignBody) },
  responses: {
    200: { ...jsonBody(AvatarPresignResponse), description: "Presigned upload" },
    401: { ...jsonBody(ErrorResponse), description: "Not authenticated" },
    422: { ...jsonBody(ErrorResponse), description: "Unsupported content type" },
  },
});

export const registerProfileRoutes = (app: OpenAPIHono<AppEnv>, runtime: AppRuntime): void => {
  const { runAuth } = makeRun(runtime);

  app.openapi(getProfile, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* ProfileService;
        return c.json(toResponse(yield* service.get(user.id)), 200);
      }),
    ),
  );

  app.openapi(updateProfile, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* ProfileService;
        const updated = yield* service.update(user.id, c.req.valid("json"));
        return c.json(toResponse(updated), 200);
      }),
    ),
  );

  app.openapi(presignAvatar, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* ProfileService;
        const result = yield* service.presignAvatar(user.id, c.req.valid("json").contentType);
        return c.json(result, 200);
      }),
    ),
  );
};
