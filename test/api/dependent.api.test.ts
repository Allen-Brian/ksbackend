import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "../support/app-harness";

const json = <T>(res: Response): Promise<T> => res.json() as Promise<T>;

// Dependent CRUD + ownership scoping against a real Postgres.
describe("dependents API (real DB)", () => {
  let harness: TestHarness;
  let ownerCookie: string;

  beforeAll(async () => {
    harness = await createTestHarness();
    ownerCookie = await harness.signUpAndVerify("owner@example.com", "password12345", "Own Er");
  });

  afterAll(() => harness.dispose());

  const newDependent = {
    surname: "Kana",
    givenNames: "Petit",
    dateOfBirth: "2015-03-02",
    sex: "female",
    relationship: "child",
  };

  it("create -> get -> list -> update -> delete -> 404", async () => {
    const created = await harness.post("/v1/dependents", newDependent, ownerCookie);
    expect(created.status).toBe(201);
    const { id } = await json<{ id: string; givenNames: string }>(created);

    const got = await harness.app.request(`/v1/dependents/${id}`, {
      headers: { cookie: ownerCookie },
    });
    expect(got.status).toBe(200);

    const listed = await harness.app.request("/v1/dependents?limit=10", {
      headers: { cookie: ownerCookie },
    });
    expect(listed.status).toBe(200);
    const page = await json<{ data: ReadonlyArray<{ id: string }> }>(listed);
    expect(page.data.some((d) => d.id === id)).toBe(true);

    const updated = await harness.app.request(`/v1/dependents/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ location: "Bamenda" }),
    });
    expect(updated.status).toBe(200);
    expect((await json<{ location: string }>(updated)).location).toBe("Bamenda");

    const deleted = await harness.app.request(`/v1/dependents/${id}`, {
      method: "DELETE",
      headers: { cookie: ownerCookie },
    });
    expect(deleted.status).toBe(204);

    const afterDelete = await harness.app.request(`/v1/dependents/${id}`, {
      headers: { cookie: ownerCookie },
    });
    expect(afterDelete.status).toBe(404);
  });

  it("a different account holder cannot see another's dependent", async () => {
    const created = await harness.post("/v1/dependents", newDependent, ownerCookie);
    const { id } = await json<{ id: string }>(created);

    const otherCookie = await harness.signUpAndVerify(
      "other@example.com",
      "password12345",
      "Oth Er",
    );
    const cross = await harness.app.request(`/v1/dependents/${id}`, {
      headers: { cookie: otherCookie },
    });
    expect(cross.status).toBe(404);
  });

  it("rejects an unauthenticated request with 401", async () => {
    expect((await harness.app.request("/v1/dependents")).status).toBe(401);
  });
});
