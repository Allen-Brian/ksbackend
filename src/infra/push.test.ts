import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import { isAllowedPushEndpoint, makePushSender, makeWebPushSender } from "./push";

const subscription = {
  endpoint: "https://fcm.googleapis.com/fcm/send/browser-token",
  keys: { p256dh: "key", auth: "secret" },
};
const input = {
  subscription,
  payload: '{"title":"Appointment reminder"}',
  dedupeKey: "appointment:one",
};
describe("push endpoint restrictions", () => {
  it.each([
    "http://fcm.googleapis.com/send",
    "https://localhost/send",
    "https://127.0.0.1/send",
    "https://[::1]/send",
    "https://fcm.googleapis.com.evil.example/send",
    "https://evil.example/push.services.mozilla.com",
    "https://user:secret@fcm.googleapis.com/send",
    "https://fcm.googleapis.com:8443/send",
    "https://web.push.apple.com/send#fragment",
  ])("rejects unsafe destination %s", (endpoint) =>
    expect(isAllowedPushEndpoint(endpoint)).toBe(false),
  );
  it.each([
    "https://fcm.googleapis.com/send",
    "https://updates.push.services.mozilla.com/wpush/v2/token",
    "https://region.push.services.mozilla.com/send",
    "https://web.push.apple.com/token",
  ])("supports browser destination %s", (endpoint) =>
    expect(isAllowedPushEndpoint(endpoint)).toBe(true),
  );
  it.effect("fails disabled push without retrying", () =>
    Effect.gen(function* () {
      const error = yield* makePushSender("", () => Promise.reject(new Error("must not call")))
        .send(input)
        .pipe(Effect.flip);
      expect(error.retryable).toBe(false);
      expect(error.ambiguous).toBe(false);
      expect(error.reason).toBe("Web Push is not configured");
    }),
  );
  it.effect("blocks unsafe delivery before transport", () =>
    Effect.gen(function* () {
      const sender = makePushSender("public", () => Promise.reject(new Error("transport called")));
      const result = yield* sender
        .send({
          ...input,
          subscription: { ...subscription, endpoint: "https://127.0.0.1/internal" },
        })
        .pipe(Effect.flip);
      expect(result.reason).toBe("Unsupported push endpoint");
      expect(result.retryable).toBe(false);
    }),
  );
  it.effect("propagates accepted delivery", () =>
    Effect.gen(function* () {
      const sender = makePushSender("public", async (address, payload) => {
        if (address.endpoint !== subscription.endpoint || payload !== input.payload)
          throw new Error("delivery changed");
      });
      yield* sender.send(input);
    }),
  );
  it.effect.each([
    { status: 410, expired: true, retryable: false },
    { status: 404, expired: true, retryable: false },
    { status: 400, expired: false, retryable: false },
    { status: 429, expired: false, retryable: true },
    { status: 503, expired: false, retryable: true },
  ])("classifies provider status $status", (row) =>
    Effect.gen(function* () {
      const sender = makePushSender("public", () =>
        Promise.reject({ statusCode: row.status, body: "sensitive provider response" }),
      );
      const error = yield* sender.send(input).pipe(Effect.flip);
      expect(error.expired).toBe(row.expired);
      expect(error.retryable).toBe(row.retryable);
      expect(error.ambiguous).toBe(false);
      expect(error.reason).not.toContain("sensitive");
    }),
  );
  it.effect("marks transport interruption as ambiguous", () =>
    Effect.gen(function* () {
      const sender = makePushSender("public", () => Promise.reject(new Error("connection closed")));
      const error = yield* sender.send(input).pipe(Effect.flip);
      expect(error.ambiguous).toBe(true);
      expect(error.retryable).toBe(true);
      expect(error.expired).toBe(false);
    }),
  );
});

// P-256 generator point and scalar 1: deterministic valid keys for local SDK validation.
const validPublicKey = Buffer.from(
  "046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5",
  "hex",
).toString("base64url");
const validConfig = {
  publicKey: validPublicKey,
  privateKey: Buffer.from(
    "0000000000000000000000000000000000000000000000000000000000000001",
    "hex",
  ).toString("base64url"),
  subject: "mailto:support@kanasante.com",
};
const validInput = {
  ...input,
  subscription: {
    ...subscription,
    keys: { p256dh: validPublicKey, auth: Buffer.alloc(16, 1).toString("base64url") },
  },
};
describe("Web Push SDK preflight", () => {
  it.effect.each([
    { name: "invalid subscription", config: validConfig, input },
    {
      name: "invalid VAPID configuration",
      config: { ...validConfig, privateKey: "invalid" },
      input: validInput,
    },
  ])("rejects $name before transport", (row) =>
    Effect.gen(function* () {
      let called = false;
      const sender = makeWebPushSender(row.config, async () => {
        called = true;
      });
      const error = yield* sender.send(row.input).pipe(Effect.flip);
      expect(called).toBe(false);
      expect(error.reason).toBe("Invalid Web Push subscription or configuration");
      expect(error.retryable).toBe(false);
      expect(error.ambiguous).toBe(false);
    }),
  );
  it.effect("valid SDK preflight preserves ambiguous network failure", () =>
    Effect.gen(function* () {
      const sender = makeWebPushSender(validConfig, () =>
        Promise.reject(new Error("network interrupted")),
      );
      const error = yield* sender.send(validInput).pipe(Effect.flip);
      expect(error.reason).toBe("Push transport failed");
      expect(error.retryable).toBe(true);
      expect(error.ambiguous).toBe(true);
    }),
  );
});
