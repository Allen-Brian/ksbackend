import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { Effect } from "effect";
import type { Review } from "@/domain/review/review";
import type { AppEnv, AppRuntime } from "@/http/app-env";
import { makeRun } from "@/http/run";
import { CursorQuery, ErrorResponse } from "@/http/schemas";
import { CurrentUser } from "@/infra/auth";
import { ReviewResponse, ReviewsPage, UpsertReviewBody } from "./review.contract";
import { ReviewService } from "./review.service";

const jsonBody = <T>(schema: T) => ({ content: { "application/json": { schema } } });

const IdParam = z.object({
  id: z.uuid().openapi({
    description: "Practitioner profile id being reviewed.",
    example: "3f1a2b6c-8d4e-4f9a-b1c2-0d3e4f5a6b7c",
  }),
});

const toResponse = (r: Review) => ({
  id: r.id,
  practitionerProfileId: r.practitionerProfileId,
  reviewerName: r.reviewerName,
  rating: r.rating,
  comment: r.comment,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

const upsert = createRoute({
  method: "post",
  path: "/v1/practitioners/{id}/reviews",
  tags: ["Reviews"],
  summary: "Create or update your review of a practitioner",
  description: [
    "Submit YOUR rating (1–5) and optional comment for a verified practitioner. You have at most",
    "one active review per practitioner: a second POST updates it (returns `200`) rather than",
    "creating a duplicate (first submission returns `201`). Requires the `patient` role (`403`",
    "otherwise); an unknown or unverified practitioner returns `404`. The practitioner's average",
    "rating and review count update atomically.",
  ].join(" "),
  request: { params: IdParam, body: jsonBody(UpsertReviewBody) },
  responses: {
    200: { ...jsonBody(ReviewResponse), description: "Your existing review was updated." },
    201: { ...jsonBody(ReviewResponse), description: "Your review was created." },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    403: { ...jsonBody(ErrorResponse), description: "Caller is not a patient." },
    404: { ...jsonBody(ErrorResponse), description: "No verified practitioner with that id." },
    422: { ...jsonBody(ErrorResponse), description: "Rating out of range or comment too long." },
  },
});

const list = createRoute({
  method: "get",
  path: "/v1/practitioners/{id}/reviews",
  tags: ["Reviews"],
  summary: "List a practitioner's reviews",
  description: [
    "A cursor-paginated list of a verified practitioner's patient reviews (newest first), each with",
    "the reviewer's given name, rating, and comment. Unknown/unverified practitioner → `404`.",
  ].join(" "),
  request: { params: IdParam, query: CursorQuery },
  responses: {
    200: { ...jsonBody(ReviewsPage), description: "A page of reviews." },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    404: { ...jsonBody(ErrorResponse), description: "No verified practitioner with that id." },
  },
});

const remove = createRoute({
  method: "delete",
  path: "/v1/practitioners/{id}/reviews/me",
  tags: ["Reviews"],
  summary: "Delete your own review",
  description: [
    "Removes YOUR review of this practitioner and recomputes their rating. Returns `404` if you",
    "have no active review for them.",
  ].join(" "),
  request: { params: IdParam },
  responses: {
    204: { description: "Your review was deleted (no body)." },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    404: { ...jsonBody(ErrorResponse), description: "You have no review for this practitioner." },
  },
});

export const registerReviewRoutes = (app: OpenAPIHono<AppEnv>, runtime: AppRuntime): void => {
  const { runAuth } = makeRun(runtime);

  app.openapi(upsert, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* ReviewService;
        const { review, created } = yield* service.upsertReview(
          user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        );
        const body = toResponse(review);
        return created ? c.json(body, 201) : c.json(body, 200);
      }),
    ),
  );

  app.openapi(list, (c) => {
    const { limit, cursor } = c.req.valid("query");
    return runAuth(
      c,
      Effect.gen(function* () {
        const service = yield* ReviewService;
        const page = yield* service.listReviews(c.req.valid("param").id, limit, cursor);
        return c.json({ data: page.data.map(toResponse), meta: page.meta }, 200);
      }),
    );
  });

  app.openapi(remove, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* ReviewService;
        yield* service.deleteOwnReview(user.id, c.req.valid("param").id);
        return c.body(null, 204);
      }),
    ),
  );
};
