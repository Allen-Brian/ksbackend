import { z } from "@hono/zod-openapi";
import { paginated } from "@/http/schemas";

export const UpsertReviewBody = z
  .object({
    rating: z
      .number()
      .int()
      .min(1)
      .max(5)
      .openapi({ description: "Star rating from 1 to 5.", example: 5 }),
    comment: z
      .string()
      .max(2000)
      .optional()
      .openapi({ description: "Optional free-text comment.", example: "Attentive and thorough." }),
  })
  .openapi("UpsertReview");

export const ReviewResponse = z
  .object({
    id: z.uuid().openapi({ description: "Review id." }),
    practitionerProfileId: z.uuid().openapi({ description: "The reviewed practitioner's id." }),
    reviewerName: z.string().nullable().openapi({
      description: "The reviewer's given name; null if unavailable.",
      example: "Marie",
    }),
    rating: z.number().int().openapi({ description: "Star rating 1–5.", example: 5 }),
    comment: z
      .string()
      .nullable()
      .openapi({ description: "Optional comment.", example: "Attentive and thorough." }),
    createdAt: z.string().openapi({ description: "ISO-8601 creation timestamp." }),
    updatedAt: z.string().openapi({ description: "ISO-8601 last-updated timestamp." }),
  })
  .openapi("Review");

export const ReviewsPage = paginated(ReviewResponse).openapi("Reviews");
