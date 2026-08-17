import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { profession } from "@/db/schema/profession";
import { createTestHarness, type TestHarness } from "../support/app-harness";

// SAFETY: API tests call endpoints with known response contracts and assert on those shapes.
const json = <T>(res: Response): Promise<T> => res.json() as Promise<T>;
const PROFESSION_ID = "00000000-0000-4000-8000-000000000081";

// Fixed instants well clear of any clock drift: a far-future day (by the hour) and a past one.
const future = (hour: number): string => `2999-01-01T${String(hour).padStart(2, "0")}:00:00.000Z`;
const PAST = "2000-01-01T09:00:00.000Z";

describe("availability API (real DB)", () => {
  let harness: TestHarness;
  let docCookie: string;
  let patientCookie: string;
  let doctorId: string;

  const createSlot = (startsAt: string, endsAt: string, cookie: string): Promise<Response> =>
    harness.post("/v1/practitioners/me/availability", { startsAt, endsAt }, cookie);

  beforeAll(async () => {
    harness = await createTestHarness();
    await harness.db
      .insert(profession)
      .values({ id: PROFESSION_ID, nameEn: "Doctor", nameFr: "Médecin", prefixHint: "Dr." });

    const adminCookie = await harness.signUpAndVerify(
      "av-admin@example.com",
      "password12345",
      "Ad",
    );
    await harness.promoteToAdmin("av-admin@example.com");

    docCookie = await harness.signUpAndVerify("av-doc@example.com", "password12345", "Doc");
    doctorId = (
      await json<{ id: string }>(
        await harness.post(
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
    await harness.post(
      "/v1/practitioners/me/credentials",
      {
        cmcRegistrationNumber: "CMC-AV",
        nicNumber: "NIC-AV",
        cmcCertificateFileKey: "practitioner-documents/av/cmc",
        nicFileKey: "practitioner-documents/av/nic",
        profilePhotoFileKey: "profile-photos/av/photo",
      },
      docCookie,
    );
    await harness.post(`/v1/admin/verifications/${doctorId}/approve`, {}, adminCookie);

    patientCookie = await harness.signUpAndVerify("av-patient@example.com", "password12345", "Pat");
  });

  afterAll(() => harness.dispose());

  it("publishes a slot (201) and lists it", async () => {
    const res = await createSlot(future(9), future(10), docCookie);
    expect(res.status).toBe(201);
    const list = await json<{ data: ReadonlyArray<{ status: string }>; meta: { count: number } }>(
      await harness.app.request("/v1/practitioners/me/availability", {
        headers: { cookie: docCookie },
      }),
    );
    expect(list.meta.count).toBe(1);
    expect(list.data[0]?.status).toBe("open");
  });

  it("surfaces the next available slot on the public profile", async () => {
    const body = await json<{ nextAvailableAt: string | null }>(
      await harness.app.request(`/v1/practitioners/${doctorId}`, {
        headers: { cookie: patientCookie },
      }),
    );
    expect(body.nextAvailableAt).toBe(future(9));
  });

  it("rejects end <= start (422)", async () => {
    const res = await createSlot(future(11), future(11), docCookie);
    expect(res.status).toBe(422);
  });

  it("rejects a slot in the past (422)", async () => {
    const res = await createSlot(PAST, "2000-01-01T10:00:00.000Z", docCookie);
    expect(res.status).toBe(422);
  });

  it("rejects an overlapping slot (409)", async () => {
    const res = await createSlot(future(9), future(10), docCookie); // same window as the first
    expect(res.status).toBe(409);
    const err = await json<{ error: { code: string } }>(res);
    expect(err.error.code).toBe("SLOT_OVERLAP");
  });

  it("forbids a non-practitioner (403)", async () => {
    const res = await createSlot(future(14), future(15), patientCookie);
    expect(res.status).toBe(403);
  });

  it("cancels a slot (204) then 404s a second cancel", async () => {
    const created = await json<{ id: string }>(await createSlot(future(12), future(13), docCookie));
    const del = await harness.app.request(`/v1/practitioners/me/availability/${created.id}`, {
      method: "DELETE",
      headers: { cookie: docCookie },
    });
    expect(del.status).toBe(204);
    const again = await harness.app.request(`/v1/practitioners/me/availability/${created.id}`, {
      method: "DELETE",
      headers: { cookie: docCookie },
    });
    expect(again.status).toBe(404);
  });
});
