import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { profession } from "@/db/schema/profession";
import { createTestHarness, type TestHarness } from "../support/app-harness";

// SAFETY: API tests call endpoints with known response contracts and assert on those shapes.
const json = <T>(res: Response): Promise<T> => res.json() as Promise<T>;
type JsonValue =
  | string
  | number
  | boolean
  | null
  | { readonly [k: string]: JsonValue }
  | ReadonlyArray<JsonValue>;
const PROFESSION_ID = "00000000-0000-4000-8000-000000000071";
const UNKNOWN_ID = "00000000-0000-4000-8000-0000000000ff";

describe("review API (real DB)", () => {
  let harness: TestHarness;
  let adminCookie: string;
  let patientA: string;
  let patientB: string;
  let doctorId: string;

  const post = async (path: string, body: JsonValue, cookie: string): Promise<Response> =>
    harness.app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    });

  const rating = async (
    cookie: string,
  ): Promise<{ ratingAverage: number; ratingCount: number }> => {
    const body = await json<{ ratingAverage: number; ratingCount: number }>(
      await harness.app.request(`/v1/practitioners/${doctorId}`, { headers: { cookie } }),
    );
    return { ratingAverage: body.ratingAverage, ratingCount: body.ratingCount };
  };

  const makePatient = async (email: string, surname: string): Promise<string> => {
    const cookie = await harness.signUpAndVerify(email, "password12345", surname);
    await harness.post(
      "/v1/patients/me/profile",
      {
        surname,
        givenNames: surname,
        dateOfBirth: "1990-01-01",
        sex: "female",
        consentVersion: "1.0",
        acceptTerms: true,
      },
      cookie,
    );
    return cookie;
  };

  beforeAll(async () => {
    harness = await createTestHarness();
    await harness.db
      .insert(profession)
      .values({ id: PROFESSION_ID, nameEn: "Doctor", nameFr: "Médecin", prefixHint: "Dr." });

    adminCookie = await harness.signUpAndVerify("rev-admin@example.com", "password12345", "Ad");
    await harness.promoteToAdmin("rev-admin@example.com");

    const docCookie = await harness.signUpAndVerify("rev-doc@example.com", "password12345", "Doc");
    doctorId = (
      await json<{ id: string }>(
        await post(
          "/v1/practitioners/register",
          {
            role: "doctor",
            professionId: PROFESSION_ID,
            surname: "Nkemtaji",
            givenNames: "Emmanuel",
            consentVersion: "1.0",
            acceptTerms: true,
          },
          docCookie,
        ),
      )
    ).id;
    await post(
      "/v1/practitioners/me/credentials",
      {
        cmcRegistrationNumber: "CMC-REV",
        nicNumber: "NIC-REV",
        cmcCertificateFileKey: "practitioner-documents/rev/cmc",
        nicFileKey: "practitioner-documents/rev/nic",
        profilePhotoFileKey: "profile-photos/rev/photo",
      },
      docCookie,
    );
    await post(`/v1/admin/verifications/${doctorId}/approve`, {}, adminCookie);

    patientA = await makePatient("rev-pat-a@example.com", "Abena");
    patientB = await makePatient("rev-pat-b@example.com", "Bello");
  });

  afterAll(() => harness.dispose());

  it("creates a review (201) and updates the practitioner's aggregate", async () => {
    const res = await post(
      `/v1/practitioners/${doctorId}/reviews`,
      { rating: 4, comment: "Good" },
      patientA,
    );
    expect(res.status).toBe(201);
    expect(await rating(patientA)).toEqual({ ratingAverage: 4, ratingCount: 1 });
  });

  it("updates the same patient's review in place (200), count unchanged", async () => {
    const res = await post(`/v1/practitioners/${doctorId}/reviews`, { rating: 2 }, patientA);
    expect(res.status).toBe(200);
    expect(await rating(patientA)).toEqual({ ratingAverage: 2, ratingCount: 1 });
  });

  it("a second patient's review shifts the average", async () => {
    const res = await post(`/v1/practitioners/${doctorId}/reviews`, { rating: 4 }, patientB);
    expect(res.status).toBe(201);
    expect(await rating(patientB)).toEqual({ ratingAverage: 3, ratingCount: 2 });
  });

  it("lists reviews (paginated) with the reviewer's name", async () => {
    const res = await harness.app.request(`/v1/practitioners/${doctorId}/reviews`, {
      headers: { cookie: patientA },
    });
    expect(res.status).toBe(200);
    const body = await json<{
      data: ReadonlyArray<{ rating: number; reviewerName: string | null }>;
      meta: { count: number };
    }>(res);
    expect(body.meta.count).toBe(2);
    expect(body.data.map((r) => r.reviewerName).sort()).toEqual(["Abena", "Bello"]);
  });

  it("rejects a caller without the patient role (403)", async () => {
    // The admin's role was replaced with `admin` on promotion, so it lacks `patient`
    // (every ordinary signed-up user defaults to the patient role).
    const res = await post(`/v1/practitioners/${doctorId}/reviews`, { rating: 5 }, adminCookie);
    expect(res.status).toBe(403);
  });

  it("404s an unknown practitioner", async () => {
    const res = await post(`/v1/practitioners/${UNKNOWN_ID}/reviews`, { rating: 5 }, patientA);
    expect(res.status).toBe(404);
  });

  it("422s a rating out of range", async () => {
    const res = await post(`/v1/practitioners/${doctorId}/reviews`, { rating: 6 }, patientA);
    expect(res.status).toBe(422);
  });

  it("deletes the caller's own review (204) and recomputes the aggregate", async () => {
    const res = await harness.app.request(`/v1/practitioners/${doctorId}/reviews/me`, {
      method: "DELETE",
      headers: { cookie: patientA },
    });
    expect(res.status).toBe(204);
    // Only patientB's rating of 4 remains.
    expect(await rating(patientA)).toEqual({ ratingAverage: 4, ratingCount: 1 });

    const again = await harness.app.request(`/v1/practitioners/${doctorId}/reviews/me`, {
      method: "DELETE",
      headers: { cookie: patientA },
    });
    expect(again.status).toBe(404);
  });
});
