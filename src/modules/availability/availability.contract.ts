import { z } from "@hono/zod-openapi";
import { SLOT_STATUSES } from "@/domain/availability/availability";
import { paginated } from "@/http/schemas";

export const CreateSlotBody = z
  .object({
    startsAt: z.iso.datetime().openapi({
      description: "Slot start (ISO-8601, must be in the future).",
      example: "2026-09-01T09:00:00.000Z",
    }),
    endsAt: z.iso.datetime().openapi({
      description: "Slot end (ISO-8601, must be after startsAt).",
      example: "2026-09-01T09:30:00.000Z",
    }),
  })
  .openapi("CreateSlot");

export const SlotResponse = z
  .object({
    id: z.uuid().openapi({ description: "Slot id." }),
    startsAt: z.string().openapi({ description: "ISO-8601 start." }),
    endsAt: z.string().openapi({ description: "ISO-8601 end." }),
    status: z.enum(SLOT_STATUSES).openapi({
      description: "Slot status. Only `open` is used until booking ships.",
      example: "open",
    }),
  })
  .openapi("Slot");

export const SlotsPage = paginated(SlotResponse).openapi("Slots");
