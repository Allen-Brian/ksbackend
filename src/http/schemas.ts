import { z } from "@hono/zod-openapi";

/** Standard error envelope — documented on every route's error responses. */
export const ErrorResponse = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      details: z.array(z.unknown()),
    }),
    requestId: z.string(),
  })
  .openapi("ErrorResponse");

/** Query params for cursor/keyset pagination (the default for all list endpoints). */
export const CursorQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20).openapi({ example: 20 }),
  cursor: z
    .string()
    .optional()
    .openapi({ description: "Opaque cursor from a previous page's meta.nextCursor" }),
});

/** Wrap an item schema in the standard `{ data, meta }` list envelope. */
export const paginated = <T extends z.ZodType>(item: T) =>
  z.object({
    data: z.array(item),
    meta: z.object({
      count: z.number().int(),
      limit: z.number().int(),
      nextCursor: z.string().nullable(),
      hasNextPage: z.boolean(),
    }),
  });
