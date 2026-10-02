import { Config, Context, Data, Effect, Layer, Option, Redacted, Schema } from "effect";
import webPush from "web-push";

export type PushSubscriptionAddress = {
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
};
export class PushError extends Data.TaggedError("PushError")<{
  readonly reason: string;
  readonly retryable: boolean;
  readonly expired: boolean;
  readonly ambiguous: boolean;
}> {}
export interface PushSenderService {
  readonly publicKey: string;
  readonly send: (input: {
    readonly subscription: PushSubscriptionAddress;
    readonly payload: string;
    readonly dedupeKey: string;
  }) => Effect.Effect<void, PushError>;
}
export class PushSender extends Context.Tag("PushSender")<PushSender, PushSenderService>() {}

/** Restrict outbound delivery to known browser push providers, never arbitrary client URLs. */
export const isAllowedPushEndpoint = (endpoint: string): boolean => {
  const parsed = URL.canParse(endpoint) ? new URL(endpoint) : undefined;
  if (
    parsed === undefined ||
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.hash !== ""
  )
    return false;
  const host = parsed.hostname;
  return (
    host === "fcm.googleapis.com" ||
    host === "updates.push.services.mozilla.com" ||
    host.endsWith(".push.services.mozilla.com") ||
    host === "web.push.apple.com"
  );
};

export type PushClient = (subscription: PushSubscriptionAddress, payload: string) => Promise<void>;
export const makePushSender = (
  publicKey: string,
  client: PushClient,
  validate: (subscription: PushSubscriptionAddress, payload: string) => void = () => {},
): PushSenderService => ({
  publicKey,
  send: ({ subscription, payload }) => {
    if (publicKey === "")
      return Effect.fail(
        new PushError({
          reason: "Web Push is not configured",
          retryable: false,
          expired: false,
          ambiguous: false,
        }),
      );
    if (!isAllowedPushEndpoint(subscription.endpoint)) {
      return Effect.fail(
        new PushError({
          reason: "Unsupported push endpoint",
          retryable: false,
          expired: false,
          ambiguous: false,
        }),
      );
    }
    return Effect.try({
      try: () => validate(subscription, payload),
      catch: () =>
        new PushError({
          reason: "Invalid Web Push subscription or configuration",
          retryable: false,
          expired: false,
          ambiguous: false,
        }),
    }).pipe(
      Effect.zipRight(
        Effect.tryPromise({
          try: () => client(subscription, payload),
          catch: (cause) => {
            const status = Option.getOrUndefined(
              Schema.decodeUnknownOption(Schema.Struct({ statusCode: Schema.Number }))(cause),
            )?.statusCode;
            return new PushError({
              reason:
                status === undefined ? "Push transport failed" : `Push provider returned ${status}`,
              retryable: status === undefined || status === 429 || status >= 500,
              expired: status === 404 || status === 410,
              ambiguous: status === undefined,
            });
          },
        }),
      ),
    );
  },
});

/** SDK request generation performs key/config validation without any network I/O. */
export const makeWebPushSender = (
  config: { readonly publicKey: string; readonly privateKey: string; readonly subject: string },
  client?: PushClient,
): PushSenderService => {
  const options = { vapidDetails: config, TTL: 300, timeout: 10_000 };
  return makePushSender(
    config.privateKey === "" ? "" : config.publicKey,
    client ??
      (async (subscription, payload) => {
        await webPush.sendNotification(subscription, payload, options);
      }),
    (subscription, payload) => {
      webPush.generateRequestDetails(subscription, payload, options);
    },
  );
};

export const PushSenderLive = Layer.effect(
  PushSender,
  Effect.gen(function* () {
    const publicKey = yield* Config.string("WEB_PUSH_PUBLIC_KEY").pipe(Config.withDefault(""));
    const privateKey = Redacted.value(
      yield* Config.redacted("WEB_PUSH_PRIVATE_KEY").pipe(Config.withDefault(Redacted.make(""))),
    );
    const subject = yield* Config.string("WEB_PUSH_SUBJECT").pipe(
      Config.withDefault("mailto:support@kanasante.com"),
    );
    return makeWebPushSender({ publicKey, privateKey, subject });
  }),
);
