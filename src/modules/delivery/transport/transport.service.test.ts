import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect } from "vitest";
import { z } from "zod";
import type { PushSubscription } from "@/domain/push-subscription/push-subscription";
import { DeliveryTransport, type DeliveryMessage } from "@/infra/delivery-transport";
import { EmailError, EmailSender, type EmailMessage } from "@/infra/email";
import { PushError, PushSender } from "@/infra/push";
import { PushSubscriptionRepo } from "@/modules/push-subscription/push-subscription.repo";
import { DeliveryTransportLive } from "./transport.service";

const subscription: PushSubscription = {
  id: "019a0000-0000-7000-8000-000000000001",
  userId: "patient",
  endpoint: "https://fcm.googleapis.com/fcm/send/device",
  keys: { p256dh: "original-public-key", auth: "original-auth" },
};
const message: DeliveryMessage = {
  appointmentId: "019a0000-0000-7000-8000-000000000002",
  channel: "email",
  to: "patient@example.com",
  userId: "patient",
  subject: "Appointment confirmed",
  html: "<p>Appointment</p>",
  text: "Your appointment is tomorrow",
  dedupeKey: "stable-provider-key",
};
const payloadSchema = z.object({
  title: z.string(),
  body: z.string(),
  tag: z.string(),
  url: z.string(),
});
const harness = (
  options: {
    emailError?: EmailError;
    pushError?: PushError;
    rotated?: boolean;
    legacyEmail?: boolean;
  } = {},
) => {
  const deliveredEmails: EmailMessage[] = [];
  const deliveredPushes: Array<{
    readonly endpoint: string;
    readonly payload: string;
    readonly dedupeKey: string;
  }> = [];
  let devices: ReadonlyArray<PushSubscription> = [
    options.rotated
      ? { ...subscription, keys: { p256dh: "new-public-key", auth: "new-auth" } }
      : subscription,
  ];
  const email = Layer.succeed(EmailSender, {
    send: (input) =>
      options.emailError === undefined
        ? Effect.sync(() => {
            deliveredEmails.push(input);
          })
        : Effect.fail(options.emailError),
    ...(!options.legacyEmail && {
      sendReceipt: (input: EmailMessage) =>
        options.emailError === undefined
          ? Effect.sync(() => {
              deliveredEmails.push(input);
              return { providerId: "accepted-email" };
            })
          : Effect.fail(options.emailError),
    }),
  });
  const push = Layer.succeed(PushSender, {
    publicKey: "public-vapid",
    send: (input) =>
      options.pushError === undefined
        ? Effect.sync(() => {
            deliveredPushes.push({
              endpoint: input.subscription.endpoint,
              payload: input.payload,
              dedupeKey: input.dedupeKey,
            });
          })
        : Effect.fail(options.pushError),
  });
  const repo = Layer.succeed(PushSubscriptionRepo, {
    lockRegistration: () => Effect.void,
    findById: (id) => Effect.sync(() => devices.find((device) => device.id === id)),
    findByUserId: (userId) =>
      Effect.sync(() => devices.filter((device) => device.userId === userId)),
    upsert: (value) =>
      Effect.sync(() => {
        devices = [...devices.filter((device) => device.id !== value.id), value];
        return value;
      }),
    remove: (userId, id) =>
      Effect.sync(() => {
        devices = devices.filter((device) => device.userId !== userId || device.id !== id);
      }),
    removeExpired: (old) =>
      Effect.sync(() => {
        devices = devices.filter(
          (device) =>
            device.id !== old.id ||
            device.userId !== old.userId ||
            device.endpoint !== old.endpoint ||
            device.keys.p256dh !== old.keys.p256dh ||
            device.keys.auth !== old.keys.auth,
        );
      }),
  });
  return {
    layer: DeliveryTransportLive.pipe(Layer.provide(Layer.mergeAll(email, push, repo))),
    deliveredEmails,
    deliveredPushes,
    devices: () => devices,
  };
};

const sendResult = (input: DeliveryMessage) =>
  Effect.gen(function* () {
    const transport = yield* DeliveryTransport;
    return yield* transport.send(input).pipe(Effect.either);
  });

it.effect("preserves the email idempotency key and provider acceptance receipt", () => {
  const fake = harness();
  return Effect.gen(function* () {
    const transport = yield* DeliveryTransport;
    const result = yield* transport.send(message);
    expect(fake.deliveredEmails[0]?.idempotencyKey).toBe("stable-provider-key");
    expect(result.providerId).toBe("accepted-email");
  }).pipe(Effect.provide(fake.layer));
});
it.effect("supports the existing sender interface while retaining email idempotency", () => {
  const fake = harness({ legacyEmail: true });
  return Effect.gen(function* () {
    const transport = yield* DeliveryTransport;
    yield* transport.send(message);
    expect(fake.deliveredEmails[0]?.idempotencyKey).toBe("stable-provider-key");
  }).pipe(Effect.provide(fake.layer));
});
it.effect("sends one device a payload matching the frontend notification contract", () => {
  const fake = harness();
  return Effect.gen(function* () {
    const transport = yield* DeliveryTransport;
    yield* transport.send({
      ...message,
      channel: "push",
      to: subscription.endpoint,
      pushSubscription: subscription,
    });
    expect(fake.deliveredPushes).toHaveLength(1);
    const delivered = fake.deliveredPushes[0];
    expect(payloadSchema.parse(JSON.parse(delivered?.payload ?? "null"))).toEqual({
      title: "Appointment confirmed",
      body: "Your appointment is tomorrow",
      tag: "stable-provider-key",
      url: "/appointments/019a0000-0000-7000-8000-000000000002",
    });
    expect(delivered?.endpoint).toBe(subscription.endpoint);
  }).pipe(Effect.provide(fake.layer));
});
it.effect("removes an expired device but preserves a concurrent registration key rotation", () => {
  const expired = new PushError({
    reason: "Gone",
    retryable: false,
    expired: true,
    ambiguous: false,
  });
  const original = harness({ pushError: expired });
  const rotated = harness({ pushError: expired, rotated: true });
  const send = Effect.gen(function* () {
    const transport = yield* DeliveryTransport;
    return yield* transport
      .send({
        ...message,
        channel: "push",
        to: subscription.endpoint,
        pushSubscription: subscription,
      })
      .pipe(Effect.either);
  });
  return Effect.gen(function* () {
    yield* send.pipe(Effect.provide(original.layer));
    expect(original.devices()).toHaveLength(0);
    yield* send.pipe(Effect.provide(rotated.layer));
    expect(rotated.devices().map((device) => device.keys.auth)).toEqual(["new-auth"]);
  });
});
it.effect("keeps email and push provider failure classifications available to retry policy", () => {
  const email = harness({
    emailError: new EmailError({
      reason: "Invalid credentials",
      retryable: false,
      ambiguous: false,
    }),
  });
  const push = harness({
    pushError: new PushError({
      reason: "Provider timeout",
      retryable: true,
      expired: false,
      ambiguous: true,
    }),
  });
  return Effect.gen(function* () {
    const emailResult = yield* sendResult(message).pipe(Effect.provide(email.layer));
    expect(emailResult).toMatchObject({
      _tag: "Left",
      left: { retryable: false, ambiguous: false },
    });
    const pushResult = yield* sendResult({
      ...message,
      channel: "push",
      to: subscription.endpoint,
      pushSubscription: subscription,
    }).pipe(Effect.provide(push.layer));
    expect(pushResult).toMatchObject({ _tag: "Left", left: { retryable: true, ambiguous: true } });
    expect(push.devices()).toHaveLength(1);
  });
});
