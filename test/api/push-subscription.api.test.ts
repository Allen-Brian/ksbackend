import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PushSubscriptionResponse } from "@/modules/push-subscription/push-subscription.contract";
import { createTestHarness, type TestHarness } from "../support/app-harness";

describe("browser push registration", () => {
  let harness: TestHarness;
  let owner: string;
  let stranger: string;
  const endpoint = "https://fcm.googleapis.com/fcm/send/test-browser";
  const keys = { p256dh: "B".repeat(87), auth: "A".repeat(22) };
  beforeAll(async () => {
    harness = await createTestHarness();
    owner = await harness.signUpAndVerify("push-owner@example.com", "secret-pass123", "Owner");
    stranger = await harness.signUpAndVerify("push-other@example.com", "secret-pass123", "Other");
  });
  afterAll(async () => {
    await harness.dispose();
  });
  it("requires authentication for key and registration", async () => {
    expect((await harness.app.request("/v1/me/push-subscriptions/public-key")).status).toBe(401);
    expect((await harness.post("/v1/me/push-subscriptions", { endpoint, keys })).status).toBe(401);
  });
  it("rejects private and lookalike destinations", async () => {
    for (const unsafe of [
      "https://127.0.0.1/internal",
      "https://fcm.googleapis.com.evil.example/token",
    ]) {
      expect(
        (await harness.post("/v1/me/push-subscriptions", { endpoint: unsafe, keys }, owner)).status,
      ).toBe(422);
    }
  });
  it("preserves ownership and registration identity across retries", async () => {
    const response = await harness.post("/v1/me/push-subscriptions", { endpoint, keys }, owner);
    expect(response.status).toBe(200);
    const first = PushSubscriptionResponse.parse(await response.json());
    const retried = await harness.post(
      "/v1/me/push-subscriptions",
      { endpoint, keys: { ...keys, auth: "C".repeat(22) } },
      owner,
    );
    expect(retried.status).toBe(200);
    const second = PushSubscriptionResponse.parse(await retried.json());
    expect(first).toMatchObject({ endpoint, keys });
    expect(second).toMatchObject({ endpoint, keys: { ...keys, auth: "C".repeat(22) } });
    expect(second).toMatchObject({ id: first.id });
    expect(
      (await harness.post("/v1/me/push-subscriptions", { endpoint, keys }, stranger)).status,
    ).toBe(409);
    expect(
      (
        await harness.app.request(`/v1/me/push-subscriptions/${first.id}`, {
          method: "DELETE",
          headers: { cookie: stranger },
        })
      ).status,
    ).toBe(204);
    // A foreign deletion cannot release the endpoint for another account.
    expect(
      (await harness.post("/v1/me/push-subscriptions", { endpoint, keys }, stranger)).status,
    ).toBe(409);
    expect(
      (
        await harness.app.request(`/v1/me/push-subscriptions/${first.id}`, {
          method: "DELETE",
          headers: { cookie: owner },
        })
      ).status,
    ).toBe(204);
    expect(
      (await harness.post("/v1/me/push-subscriptions", { endpoint, keys }, stranger)).status,
    ).toBe(200);
  });
  it("enforces subscription cap with concurrent registrations", async () => {
    const responses = await Promise.all(
      Array.from({ length: 11 }, (_, index) =>
        harness.post(
          "/v1/me/push-subscriptions",
          { endpoint: `https://fcm.googleapis.com/fcm/send/cap-${index}`, keys },
          owner,
        ),
      ),
    );
    expect(responses.filter((response) => response.status === 200)).toHaveLength(10);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(1);
  });
  it("rejects malformed browser key material", async () => {
    expect(
      (
        await harness.post(
          "/v1/me/push-subscriptions",
          { endpoint, keys: { p256dh: "invalid", auth: "invalid" } },
          owner,
        )
      ).status,
    ).toBe(422);
  });
});

describe("unconfigured browser push", () => {
  let harness: TestHarness;
  let cookie: string;
  beforeAll(async () => {
    harness = await createTestHarness(undefined, {
      pushSender: { publicKey: "", send: () => Effect.void },
    });
    cookie = await harness.signUpAndVerify(
      "disabled-push@example.com",
      "secret-pass123",
      "Disabled",
    );
  });
  afterAll(async () => {
    await harness.dispose();
  });
  it("reports unavailable public key and refuses registration", async () => {
    const key = await harness.app.request("/v1/me/push-subscriptions/public-key", {
      headers: { cookie },
    });
    expect(key.status).toBe(200);
    expect(await key.json()).toEqual({ enabled: false, publicKey: null });
    expect(
      (
        await harness.post(
          "/v1/me/push-subscriptions",
          {
            endpoint: "https://fcm.googleapis.com/fcm/send/disabled",
            keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) },
          },
          cookie,
        )
      ).status,
    ).toBe(409);
  });
});
