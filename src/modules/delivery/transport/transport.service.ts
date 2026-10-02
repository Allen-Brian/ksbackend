import { Effect, Layer } from "effect";
import { DeliveryTransport, DeliveryTransportError } from "@/infra/delivery-transport";
import { EmailSender } from "@/infra/email";
import { PushSender } from "@/infra/push";
import { PushSubscriptionRepo } from "@/modules/push-subscription/push-subscription.repo";

/** Provider composition belongs in modules: infrastructure never imports repositories. */
export const DeliveryTransportLive = Layer.effect(
  DeliveryTransport,
  Effect.gen(function* () {
    const email = yield* EmailSender;
    const push = yield* PushSender;
    const subscriptions = yield* PushSubscriptionRepo;
    return {
      listPushSubscriptions: subscriptions.findByUserId,
      send: (message) => {
        if (message.channel === "email") {
          const input = {
            to: message.to,
            subject: message.subject,
            html: message.html,
            idempotencyKey: message.dedupeKey,
          };
          return (
            email.sendReceipt === undefined
              ? email.send(input).pipe(Effect.as({ providerId: undefined }))
              : email.sendReceipt(input)
          ).pipe(
            Effect.mapError(
              (error) =>
                new DeliveryTransportError({
                  reason: error.reason,
                  retryable: error.retryable ?? true,
                  ambiguous: error.ambiguous ?? true,
                }),
            ),
          );
        }
        const subscription = message.pushSubscription;
        if (subscription === undefined) {
          return Effect.fail(
            new DeliveryTransportError({
              reason: "Push subscription missing",
              retryable: false,
              ambiguous: false,
            }),
          );
        }
        return push
          .send({
            subscription,
            dedupeKey: message.dedupeKey,
            payload: JSON.stringify({
              title: message.subject,
              body: message.text,
              tag: message.dedupeKey,
              url: `/appointments/${message.appointmentId}`,
            }),
          })
          .pipe(
            Effect.catchAll((error) =>
              (error.expired
                ? subscriptions
                    .removeExpired(subscription)
                    .pipe(
                      Effect.catchAll(() =>
                        Effect.logWarning("Expired push subscription cleanup failed"),
                      ),
                    )
                : Effect.void
              ).pipe(
                Effect.zipRight(
                  Effect.fail(
                    new DeliveryTransportError({
                      reason: error.reason,
                      retryable: error.retryable,
                      ambiguous: error.ambiguous,
                    }),
                  ),
                ),
              ),
            ),
            Effect.as({ providerId: undefined }),
          );
      },
    } satisfies typeof DeliveryTransport.Service;
  }),
);
