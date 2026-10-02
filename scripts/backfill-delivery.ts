import { Config, Effect } from "effect";
import { DeliveryService } from "@/modules/delivery/delivery.service";
import { makeDeliveryBackfillRuntime } from "@/runtime";

// Operator entry point. Queue at most 1,000 future appointments per invocation;
// never contact providers. The printed cursor can resume a larger deployment.
const initialCursor = await Effect.runPromise(
  Config.string("DELIVERY_BACKFILL_CURSOR").pipe(
    Config.withDefault(""),
    Config.validate({
      message: "DELIVERY_BACKFILL_CURSOR must be a UUID or blank",
      validation: (cursor) =>
        cursor === "" ||
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cursor),
    }),
  ),
);
const runtime = makeDeliveryBackfillRuntime();
const result = await runtime
  .runPromise(
    Effect.gen(function* () {
      const service = yield* DeliveryService;
      let cursor = initialCursor === "" ? undefined : initialCursor;
      let count = 0;
      for (let batch = 0; batch < 10; batch++) {
        const page = yield* service.backfill({
          limit: 100,
          ...(cursor !== undefined && { cursor }),
        });
        count += page.count;
        cursor = page.nextCursor;
        if (page.count < 100) return { count, nextCursor: undefined };
      }
      return { count, nextCursor: cursor };
    }),
  )
  .finally(() => runtime.dispose());
console.log(JSON.stringify(result));
