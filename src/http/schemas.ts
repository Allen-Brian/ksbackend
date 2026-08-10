import { z } from "@hono/zod-openapi";

/** Standard error envelope — documented on every route's error responses. */
export const ErrorResponse = z
  .object({
    error: z
      .object({
        code: z.string().openapi({
          description: "Stable, machine-readable error code (never localized).",
          example: "VALIDATION_FAILED",
        }),
        message: z.string().openapi({
          description: "Human-readable message, localized to the caller's locale (en/fr).",
          example: "Request validation failed.",
        }),
        details: z
          .array(z.unknown())
          .openapi({ description: "Optional field-level issues; empty for most errors." }),
      })
      .openapi({
        description: "The error detail (code + localized message + optional field issues).",
      }),
    requestId: z.string().openapi({
      description: "Correlation id — quote it when reporting a problem.",
      example: "req_a1b2c3",
    }),
  })
  .openapi("ErrorResponse");

/** Query params for cursor/keyset pagination (the default for all list endpoints). */
export const CursorQuery = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .openapi({ description: "Max items per page (1–100, default 20).", example: 20 }),
  cursor: z.string().optional().openapi({
    description:
      "Opaque cursor: pass the previous page's `meta.nextCursor` to fetch the next page. Omit for the first page.",
  }),
});

/** Wrap an item schema in the standard `{ data, meta }` list envelope. */
export const paginated = <T extends z.ZodType>(item: T) =>
  z.object({
    data: z.array(item).openapi({ description: "The items in this page." }),
    meta: z
      .object({
        count: z
          .number()
          .int()
          .openapi({ description: "Number of items in this page.", example: 20 }),
        limit: z
          .number()
          .int()
          .openapi({ description: "The page size that was applied.", example: 20 }),
        nextCursor: z
          .string()
          .nullable()
          .openapi({ description: "Pass as `?cursor=` for the next page; null on the last page." }),
        hasNextPage: z
          .boolean()
          .openapi({ description: "True when another page is available.", example: true }),
      })
      .openapi({ description: "Cursor-pagination metadata." }),
  });
