import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "../support/app-harness";

// SAFETY: API tests call endpoints with known response contracts and immediately assert on those shapes.
const json = <T>(res: Response): Promise<T> => res.json() as Promise<T>;

type EmergencyContact = { name: string; phone: string; relationship: string };
type PatientProfile = { emergencyContact: EmergencyContact | null };

// The patient-specific part of the profile (emergency contact) written by
// POST /v1/patients/me/profile (onboarding, re-stamps consent) and edited via
// PATCH /v1/patients/me/profile (no consent involved).
describe("patient profile emergency contact API (real DB)", () => {
  let harness: TestHarness;
  let cookie: string;

  const baseProfile = {
    surname: "Mbeki",
    givenNames: "Ama",
    dateOfBirth: "1990-05-01",
    sex: "female",
    consentVersion: "2025-01",
    acceptTerms: true,
  };
  const sister: EmergencyContact = {
    name: "Ngo Mbeki",
    phone: "+237699000000",
    relationship: "Sister",
  };
  const brother: EmergencyContact = {
    name: "Kofi Mbeki",
    phone: "+237677000000",
    relationship: "Brother",
  };

  const getProfile = () => harness.app.request("/v1/patients/me/profile", { headers: { cookie } });

  // `null` sends no session cookie at all (an explicit `undefined` would fall
  // back to the default and silently authenticate the request).
  const patch = (body: string, sessionCookie: string | null = cookie) =>
    harness.app.request("/v1/patients/me/profile", {
      method: "PATCH",
      headers:
        sessionCookie === null
          ? { "content-type": "application/json" }
          : { "content-type": "application/json", cookie: sessionCookie },
      body,
    });

  beforeAll(async () => {
    harness = await createTestHarness();
    cookie = await harness.signUpAndVerify("patient@example.com", "password12345", "Ama Mbeki");
  });

  afterAll(() => harness.dispose());

  it("re-submitting the profile without emergencyContact leaves the stored contact intact", async () => {
    const first = await harness.post(
      "/v1/patients/me/profile",
      { ...baseProfile, emergencyContact: sister },
      cookie,
    );
    expect(first.status).toBe(200);
    expect((await json<PatientProfile>(first)).emergencyContact).toEqual(sister);

    // Regression: this used to NULL the three emergency_contact_* columns.
    const second = await harness.post("/v1/patients/me/profile", baseProfile, cookie);
    expect(second.status).toBe(200);

    const got = await getProfile();
    expect(got.status).toBe(200);
    expect((await json<PatientProfile>(got)).emergencyContact).toEqual(sister);
  });

  it("PATCH with an object replaces the contact", async () => {
    const res = await patch(JSON.stringify({ emergencyContact: brother }));
    expect(res.status).toBe(200);
    expect((await json<PatientProfile>(res)).emergencyContact).toEqual(brother);

    expect((await json<PatientProfile>(await getProfile())).emergencyContact).toEqual(brother);
  });

  it("PATCH with {} leaves the contact untouched", async () => {
    const res = await patch(JSON.stringify({}));
    expect(res.status).toBe(200);
    expect((await json<PatientProfile>(res)).emergencyContact).toEqual(brother);
  });

  it("PATCH with emergencyContact: null clears it", async () => {
    const res = await patch(JSON.stringify({ emergencyContact: null }));
    expect(res.status).toBe(200);
    expect((await json<PatientProfile>(res)).emergencyContact).toBeNull();

    expect((await json<PatientProfile>(await getProfile())).emergencyContact).toBeNull();
  });

  it("PATCH rejects a malformed contact with 422 and keeps the stored value", async () => {
    // Put a known contact back first so the "kept" assertion is meaningful.
    expect((await patch(JSON.stringify({ emergencyContact: sister }))).status).toBe(200);

    const res = await patch(
      JSON.stringify({ emergencyContact: { ...sister, phone: "not-a-phone" } }),
    );
    expect(res.status).toBe(422);
    expect((await json<PatientProfile>(await getProfile())).emergencyContact).toEqual(sister);
  });

  it("PATCH 404s for a user with no patient profile yet", async () => {
    const other = await harness.signUpAndVerify(
      "no-patient@example.com",
      "password12345",
      "No Patient",
    );
    const res = await patch(JSON.stringify({ emergencyContact: sister }), other);
    expect(res.status).toBe(404);
  });

  it("PATCH rejects an unauthenticated request with 401", async () => {
    const res = await patch(JSON.stringify({ emergencyContact: sister }), null);
    expect(res.status).toBe(401);
  });
});
