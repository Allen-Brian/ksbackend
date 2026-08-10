import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "../support/app-harness";

const json = <T>(res: Response): Promise<T> => res.json() as Promise<T>;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// Linked (account) dependents: invite -> accept -> active, with the token emailed
// to the invitee, symmetric revoke, and exact-match user search.
describe("caregiver invitations API (real DB)", () => {
  let harness: TestHarness;
  let caregiver: string;

  const tokenFor = (email: string): string => {
    const msg = harness.sent.toReversed().find((m) => m.to === email && /accept/i.test(m.html));
    const match = msg?.html.match(UUID);
    if (match === null || match === undefined) throw new Error(`no invite token for ${email}`);
    return match[0];
  };

  beforeAll(async () => {
    harness = await createTestHarness();
    caregiver = await harness.signUpAndVerify(
      "caregiver@example.com",
      "password12345",
      "Care Giver",
    );
  });

  afterAll(() => harness.dispose());

  it("invite -> emailed token -> accept -> active link, visible to both parties", async () => {
    const inviteeEmail = "linked-dep@example.com";
    const inviteeCookie = await harness.signUpAndVerify(
      inviteeEmail,
      "password12345",
      "Linked Dep",
    );

    const invited = await harness.post(
      "/v1/dependents/invitations",
      { inviteeEmail, relationship: "parent" },
      caregiver,
    );
    expect(invited.status).toBe(201);
    const link = await json<{ id: string; status: string; direction: string }>(invited);
    expect(link.status).toBe("pending");
    expect(link.direction).toBe("sent");

    const token = tokenFor(inviteeEmail);
    const accepted = await harness.post(`/v1/invitations/${token}/accept`, {}, inviteeCookie);
    expect(accepted.status).toBe(200);
    const active = await json<{ status: string; subjectUserId: string | null }>(accepted);
    expect(active.status).toBe("active");
    expect(active.subjectUserId).not.toBeNull();

    // Caregiver sees it as sent+active; invitee sees it as received.
    const mine = await json<{
      links: ReadonlyArray<{ id: string; direction: string; status: string }>;
    }>(await harness.app.request("/v1/me/invitations", { headers: { cookie: caregiver } }));
    expect(
      mine.links.some((l) => l.id === link.id && l.direction === "sent" && l.status === "active"),
    ).toBe(true);
    const theirs = await json<{ links: ReadonlyArray<{ id: string; direction: string }> }>(
      await harness.app.request("/v1/me/invitations", { headers: { cookie: inviteeCookie } }),
    );
    expect(theirs.links.some((l) => l.id === link.id && l.direction === "received")).toBe(true);

    // Either party can revoke.
    expect(
      (
        await harness.app.request(`/v1/dependents/links/${link.id}`, {
          method: "DELETE",
          headers: { cookie: inviteeCookie },
        })
      ).status,
    ).toBe(204);
  });

  it("rejects inviting yourself (422) and duplicate invites (409)", async () => {
    expect(
      (
        await harness.post(
          "/v1/dependents/invitations",
          { inviteeEmail: "caregiver@example.com", relationship: "other" },
          caregiver,
        )
      ).status,
    ).toBe(422);

    const dup = { inviteeEmail: "dup-invitee@example.com", relationship: "sibling" as const };
    expect((await harness.post("/v1/dependents/invitations", dup, caregiver)).status).toBe(201);
    expect((await harness.post("/v1/dependents/invitations", dup, caregiver)).status).toBe(409);
  });

  it("accept: 404 for an unknown token, 403 when addressed to another user", async () => {
    expect(
      (await harness.post(`/v1/invitations/${crypto.randomUUID()}/accept`, {}, caregiver)).status,
    ).toBe(404);

    const inviteeEmail = "wrong-user-dep@example.com";
    await harness.post(
      "/v1/dependents/invitations",
      { inviteeEmail, relationship: "child" },
      caregiver,
    );
    const token = tokenFor(inviteeEmail);
    // A different user (the caregiver) tries to accept an invite addressed elsewhere.
    expect((await harness.post(`/v1/invitations/${token}/accept`, {}, caregiver)).status).toBe(403);
  });

  it("user search: exact match returns a card, miss returns null", async () => {
    const found = await json<{ user: { displayName: string } | null }>(
      await harness.app.request("/v1/users/search?email=linked-dep@example.com", {
        headers: { cookie: caregiver },
      }),
    );
    expect(found.user?.displayName).toContain("Linked");

    const miss = await json<{ user: unknown }>(
      await harness.app.request("/v1/users/search?email=nobody@example.com", {
        headers: { cookie: caregiver },
      }),
    );
    expect(miss.user).toBeNull();
  });
});
