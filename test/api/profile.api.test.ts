import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "../support/app-harness";

const json = <T>(res: Response): Promise<T> => res.json() as Promise<T>;

// The base profile (1:1 with the user) shared by every role, read/edited via
// /v1/me/profile. Populated when a role profile is first completed.
describe("base profile API (real DB)", () => {
  let harness: TestHarness;
  let cookie: string;

  beforeAll(async () => {
    harness = await createTestHarness();
    cookie = await harness.signUpAndVerify("profile@example.com", "password12345", "Prof Ile");
  });

  afterAll(() => harness.dispose());

  it("404s before any profile exists, then reflects the completed profile", async () => {
    expect((await harness.app.request("/v1/me/profile", { headers: { cookie } })).status).toBe(404);

    // Completing the patient profile creates the base profile.
    expect(
      (
        await harness.post(
          "/v1/patients/me/profile",
          {
            surname: "Ile",
            givenNames: "Prof",
            dateOfBirth: "1990-01-01",
            sex: "male",
            consentVersion: "1.0",
            acceptTerms: true,
          },
          cookie,
        )
      ).status,
    ).toBe(200);

    const got = await harness.app.request("/v1/me/profile", { headers: { cookie } });
    expect(got.status).toBe(200);
    const body = await json<{ surname: string; givenNames: string; sex: string }>(got);
    expect(body.surname).toBe("Ile");
    expect(body.sex).toBe("male");
  });

  it("PATCH edits mutable base fields", async () => {
    const patched = await harness.app.request("/v1/me/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ surname: "Renamed", phone: "+237650000000" }),
    });
    expect(patched.status).toBe(200);
    const body = await json<{ surname: string; phone: string }>(patched);
    expect(body.surname).toBe("Renamed");
    expect(body.phone).toBe("+237650000000");
  });

  it("PATCH 404s for a user with no profile yet", async () => {
    const other = await harness.signUpAndVerify(
      "noprofile@example.com",
      "password12345",
      "No Profile",
    );
    const res = await harness.app.request("/v1/me/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: other },
      body: JSON.stringify({ surname: "X" }),
    });
    expect(res.status).toBe(404);
  });
});
