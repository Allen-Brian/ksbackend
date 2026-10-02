import { SqlClient, SqlError } from "@effect/sql";
import { Clock, Context, Effect, Layer } from "effect";
import type { PushSubscription } from "@/domain/push-subscription/push-subscription";
import { Conflict, ValidationFailed } from "@/domain/shared/errors";
import { IdGenerator } from "@/infra/ids";
import { isAllowedPushEndpoint, PushSender } from "@/infra/push";
import { PushSubscriptionRepo } from "./push-subscription.repo";

export interface PushSubscriptionServiceService {
  readonly publicKey: string;
  readonly register: (
    userId: string,
    input: Omit<PushSubscription, "id" | "userId">,
  ) => Effect.Effect<PushSubscription, SqlError.SqlError | Conflict | ValidationFailed>;
  readonly remove: (userId: string, id: string) => Effect.Effect<void, SqlError.SqlError>;
}
export class PushSubscriptionService extends Context.Tag("PushSubscriptionService")<
  PushSubscriptionService,
  PushSubscriptionServiceService
>() {}
export const PushSubscriptionServiceLive = Layer.effect(
  PushSubscriptionService,
  Effect.gen(function* () {
    const repo = yield* PushSubscriptionRepo;
    const ids = yield* IdGenerator;
    const sender = yield* PushSender;
    const sql = yield* SqlClient.SqlClient;
    return {
      publicKey: sender.publicKey,
      register: (userId, input) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* repo.lockRegistration(userId);
            if (sender.publicKey === "")
              return yield* Effect.fail(
                new Conflict({
                  resource: "Push subscription",
                  reason: "Web Push is not configured.",
                }),
              );
            if (!isAllowedPushEndpoint(input.endpoint))
              return yield* Effect.fail(
                new ValidationFailed({
                  issues: [{ path: "endpoint", message: "Unsupported browser push provider." }],
                }),
              );
            const found = yield* repo.findByUserId(userId);
            if (
              found.length >= 10 &&
              !found.some((subscription) => subscription.endpoint === input.endpoint)
            )
              return yield* Effect.fail(
                new Conflict({
                  resource: "Push subscription",
                  reason: "Maximum ten browser subscriptions per account.",
                }),
              );
            const result = yield* repo.upsert(
              { ...input, userId, id: yield* ids.next },
              new Date(yield* Clock.currentTimeMillis),
            );
            return result === undefined
              ? yield* Effect.fail(
                  new Conflict({
                    resource: "Push subscription",
                    reason: "Endpoint already belongs to another account.",
                  }),
                )
              : result;
          }),
        ),
      remove: (userId, id) => repo.remove(userId, id),
    } satisfies PushSubscriptionServiceService;
  }),
);
