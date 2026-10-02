import { SqlError } from "@effect/sql";
import { Context, Data, Effect } from "effect";

export type DeliveryPushSubscription = {
  readonly id: string;
  readonly userId: string;
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
};

export type DeliveryMessage = {
  readonly appointmentId: string;
  readonly channel: "email" | "push";
  readonly to: string;
  readonly userId: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly dedupeKey: string;
  readonly pushSubscription?: DeliveryPushSubscription | undefined;
};

export class DeliveryTransportError extends Data.TaggedError("DeliveryTransportError")<{
  readonly reason: string;
  readonly retryable: boolean;
  readonly ambiguous: boolean;
}> {}

export class DeliveryTransport extends Context.Tag("DeliveryTransport")<
  DeliveryTransport,
  {
    readonly listPushSubscriptions: (
      userId: string,
    ) => Effect.Effect<ReadonlyArray<DeliveryPushSubscription>, SqlError.SqlError>;
    readonly send: (
      message: DeliveryMessage,
    ) => Effect.Effect<{ readonly providerId: string | undefined }, DeliveryTransportError>;
  }
>() {}
