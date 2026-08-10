import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { Effect } from "effect";
import type { CaregiverLinkView } from "@/domain/invitation/invitation";
import type { AppEnv, AppRuntime } from "@/http/app-env";
import { makeRun } from "@/http/run";
import { ErrorResponse } from "@/http/schemas";
import { CurrentUser } from "@/infra/auth";
import {
  InviteBody,
  LinkIdParam,
  LinkResponse,
  LinksResponse,
  TokenParam,
  UserSearchQuery,
  UserSearchResponse,
} from "./invitation.contract";
import { InvitationService } from "./invitation.service";

const jsonBody = <T>(schema: T) => ({ content: { "application/json": { schema } } });

const toView = (v: CaregiverLinkView) => ({
  id: v.id,
  caregiverUserId: v.caregiverUserId,
  subjectUserId: v.subjectUserId,
  inviteIdentifier: v.inviteIdentifier,
  relationship: v.relationship,
  status: v.status,
  direction: v.direction,
});

const invite = createRoute({
  method: "post",
  path: "/v1/dependents/invitations",
  tags: ["Dependents"],
  summary: "Invite an account-holder to be linked as a dependent",
  request: { body: jsonBody(InviteBody) },
  responses: {
    201: { ...jsonBody(LinkResponse), description: "Invitation sent (pending)" },
    401: { ...jsonBody(ErrorResponse), description: "Not authenticated" },
    409: { ...jsonBody(ErrorResponse), description: "Already invited / cannot link self" },
    422: { ...jsonBody(ErrorResponse), description: "Validation failed" },
  },
});

const listMine = createRoute({
  method: "get",
  path: "/v1/me/invitations",
  tags: ["Dependents"],
  summary: "Caregiver links sent by / addressed to the current user",
  responses: {
    200: { ...jsonBody(LinksResponse), description: "Links" },
    401: { ...jsonBody(ErrorResponse), description: "Not authenticated" },
  },
});

const accept = createRoute({
  method: "post",
  path: "/v1/invitations/{token}/accept",
  tags: ["Dependents"],
  summary: "Accept a caregiver invitation (activates the link)",
  request: { params: TokenParam },
  responses: {
    200: { ...jsonBody(LinkResponse), description: "Accepted (active)" },
    401: { ...jsonBody(ErrorResponse), description: "Not authenticated" },
    403: { ...jsonBody(ErrorResponse), description: "Addressed to another user" },
    404: { ...jsonBody(ErrorResponse), description: "No such invitation" },
    409: { ...jsonBody(ErrorResponse), description: "Expired / already responded" },
  },
});

const decline = createRoute({
  method: "post",
  path: "/v1/invitations/{token}/decline",
  tags: ["Dependents"],
  summary: "Decline a caregiver invitation",
  request: { params: TokenParam },
  responses: {
    204: { description: "Declined" },
    401: { ...jsonBody(ErrorResponse), description: "Not authenticated" },
    403: { ...jsonBody(ErrorResponse), description: "Addressed to another user" },
    404: { ...jsonBody(ErrorResponse), description: "No such invitation" },
    409: { ...jsonBody(ErrorResponse), description: "Expired / already responded" },
  },
});

const unlink = createRoute({
  method: "delete",
  path: "/v1/dependents/links/{id}",
  tags: ["Dependents"],
  summary: "Revoke a caregiver link (either party)",
  request: { params: LinkIdParam },
  responses: {
    204: { description: "Revoked" },
    401: { ...jsonBody(ErrorResponse), description: "Not authenticated" },
    404: { ...jsonBody(ErrorResponse), description: "No such link" },
  },
});

const search = createRoute({
  method: "get",
  path: "/v1/users/search",
  tags: ["Dependents"],
  summary: "Exact-match lookup of a user by email (for linking)",
  request: { query: UserSearchQuery },
  responses: {
    200: { ...jsonBody(UserSearchResponse), description: "The matching user, or null" },
    401: { ...jsonBody(ErrorResponse), description: "Not authenticated" },
    422: { ...jsonBody(ErrorResponse), description: "Validation failed" },
  },
});

export const registerInvitationRoutes = (app: OpenAPIHono<AppEnv>, runtime: AppRuntime): void => {
  const { runAuth } = makeRun(runtime);

  app.openapi(invite, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* InvitationService;
        const body = c.req.valid("json");
        const link = yield* service.invite({
          caregiverUserId: user.id,
          caregiverEmail: user.email,
          inviteeEmail: body.inviteeEmail,
          relationship: body.relationship,
        });
        return c.json(toView(link), 201);
      }),
    ),
  );

  app.openapi(listMine, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* InvitationService;
        const links = yield* service.listMine(user.id, user.email);
        return c.json({ links: links.map(toView) }, 200);
      }),
    ),
  );

  app.openapi(accept, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* InvitationService;
        const link = yield* service.accept(user.id, user.email, c.req.valid("param").token);
        return c.json(toView(link), 200);
      }),
    ),
  );

  app.openapi(decline, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* InvitationService;
        yield* service.decline(user.id, user.email, c.req.valid("param").token);
        return c.body(null, 204);
      }),
    ),
  );

  app.openapi(unlink, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* InvitationService;
        yield* service.revoke(user.id, c.req.valid("param").id);
        return c.body(null, 204);
      }),
    ),
  );

  app.openapi(search, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const service = yield* InvitationService;
        const found = yield* service.searchUser(c.req.valid("query").email);
        return c.json({ user: found }, 200);
      }),
    ),
  );
};
