import { eq, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appointment } from "@/db/schema/appointment";
import { practitionerProfile } from "@/db/schema/practitioner-profile";
import { profession } from "@/db/schema/profession";
import { createTestHarness, type TestHarness } from "../support/app-harness";

// SAFETY: API tests call endpoints with known response contracts and assert on those shapes.
const json = <T>(response: Response): Promise<T> => response.json() as Promise<T>;
type JsonValue =
  | string
  | number
  | boolean
  | null
  | { readonly [key: string]: JsonValue }
  | ReadonlyArray<JsonValue>;

const PROFESSION_ID = "0198e3f0-5000-7000-8000-000000000001";
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
// Pinned "now": late Thursday 2026-10-01 UTC — already Friday 2026-10-02 in Douala,
// so anything that confuses UTC with the practice timezone turns red. Fixtures
// live on the following Monday/Tuesday so the maths is the same on any day.
const NOW = new Date("2026-10-01T23:30:00.000Z");
const MONDAY = "2026-10-05";
const WINDOW = "from=2026-10-05T00:00:00.000Z&to=2026-10-07T00:00:00.000Z";

type Slot = {
  readonly key: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly consultationTypes: ReadonlyArray<string>;
  readonly locationId: string | null;
};
type AppointmentBody = {
  readonly id: string;
  readonly status: string;
  readonly revision: number;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly holdExpiresAt: string | null;
  readonly locationId: string | null;
  readonly subject: {
    readonly kind: string;
    readonly dependentId: string | null;
    readonly subjectUserId: string | null;
  };
};
type ErrorBody = { readonly error: { readonly code: string } };

type Clinic = {
  readonly doctorCookie: string;
  readonly doctorId: string;
  readonly locationId: string;
  readonly inPersonOfferingId: string;
  readonly videoOfferingId: string;
};

const request = async (
  harness: TestHarness,
  method: string,
  path: string,
  cookie: string | undefined,
  body?: JsonValue,
): Promise<Response> =>
  await harness.app.request(path, {
    method,
    headers:
      body === undefined
        ? cookie === undefined
          ? undefined
          : { cookie }
        : cookie === undefined
          ? { "content-type": "application/json" }
          : { cookie, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** A verified doctor with a location, offerings, and Mon/Tue/Fri morning rules. */
const setUpClinic = async (harness: TestHarness, tag: string): Promise<Clinic> => {
  const adminCookie = await harness.signUpAndVerify(
    `${tag}-admin@example.com`,
    "password12345",
    "Ad",
  );
  await harness.promoteToAdmin(`${tag}-admin@example.com`);
  const doctorCookie = await harness.signUpAndVerify(
    `${tag}-doc@example.com`,
    "password12345",
    "Doc",
  );
  const doctorUserId = await harness.userIdFor(`${tag}-doc@example.com`);
  const doctorId = (
    await json<{ id: string }>(
      await harness.post(
        "/v1/practitioners/register",
        {
          role: "doctor",
          professionId: PROFESSION_ID,
          surname: "Ngassa",
          givenNames: "Marie",
          consultationTypes: ["in_person", "video"],
          consentVersion: "1.0",
          acceptTerms: true,
        },
        doctorCookie,
      ),
    )
  ).id;
  await harness.post(
    "/v1/practitioners/me/credentials",
    {
      cmcRegistrationNumber: `CMC-${tag}`,
      nicNumber: `NIC-${tag}`,
      cmcCertificateFileKey: `practitioner-documents/${doctorUserId}/cmc`,
      nicFileKey: `practitioner-documents/${doctorUserId}/nic`,
      profilePhotoFileKey: `profile-photos/${doctorUserId}/photo`,
    },
    doctorCookie,
  );
  expect(
    (await harness.post(`/v1/admin/verifications/${doctorId}/approve`, {}, adminCookie)).status,
  ).toBe(200);
  await harness.db
    .update(practitionerProfile)
    .set({ languagesSpoken: ["fr", "en"] })
    .where(eq(practitionerProfile.id, doctorId));

  const locationId = (
    await json<{ id: string }>(
      await harness.post(
        "/v1/practitioners/me/locations",
        {
          label: "Cabinet Bonanjo",
          addressLine1: "Rue Joss",
          city: "Douala",
          region: "Littoral",
          consultationTypes: ["in_person"],
        },
        doctorCookie,
      ),
    )
  ).id;
  const inPersonOfferingId = (
    await json<{ id: string }>(
      await harness.post(
        "/v1/practitioners/me/offerings",
        { consultationType: "in_person", durationMin: 30, priceXaf: 10_000 },
        doctorCookie,
      ),
    )
  ).id;
  const videoOfferingId = (
    await json<{ id: string }>(
      await harness.post(
        "/v1/practitioners/me/offerings",
        { consultationType: "video", durationMin: 30, priceXaf: 8_000 },
        doctorCookie,
      ),
    )
  ).id;
  const rule = (weekday: number) => ({
    weekday,
    startTime: "09:00",
    endTime: "12:00",
    slotDurationMin: 30,
    consultationTypes: ["in_person", "video"],
    locationId,
  });
  expect(
    (
      await request(harness, "PUT", "/v1/practitioners/me/availability/rules", doctorCookie, {
        // Friday also has an overnight window: its second slot starts on Saturday.
        rules: [
          rule(1),
          rule(2),
          rule(5),
          { ...rule(5), startTime: "23:00", endTime: "01:00", slotDurationMin: 60 },
        ],
      })
    ).status,
  ).toBe(200);
  return { doctorCookie, doctorId, locationId, inPersonOfferingId, videoOfferingId };
};

const completePatient = async (
  harness: TestHarness,
  cookie: string,
  surname: string,
  givenNames: string,
): Promise<void> => {
  expect(
    (
      await harness.post(
        "/v1/patients/me/profile",
        {
          surname,
          givenNames,
          dateOfBirth: "1985-06-15",
          sex: "female",
          consentVersion: "1.0",
          acceptTerms: true,
        },
        cookie,
      )
    ).status,
  ).toBe(200);
};

const slotsFor = async (harness: TestHarness, cookie: string, doctorId: string): Promise<Slot[]> =>
  (
    await json<{ data: Slot[] }>(
      await request(harness, "GET", `/v1/practitioners/${doctorId}/availability?${WINDOW}`, cookie),
    )
  ).data;

const slotAt = (slots: ReadonlyArray<Slot>, startsAt: string): Slot => {
  const found = slots.find((slot) => slot.startsAt === startsAt);
  if (found === undefined) throw new Error(`no slot at ${startsAt}`);
  return found;
};

describe("appointments API (real DB)", () => {
  let harness: TestHarness;
  let clinic: Clinic;
  let patientA: string;
  let patientB: string;
  let noProfile: string;
  let linkedCookie: string;
  let linkedUserId: string;
  let linkId: string;
  let dependentId: string;
  let slots: Slot[];

  const hold = (
    cookie: string,
    slot: Slot,
    extra: { readonly [key: string]: JsonValue } = {},
  ): Promise<Response> =>
    harness.post(
      "/v1/appointments",
      {
        practitionerId: clinic.doctorId,
        slotKey: slot.key,
        startsAt: slot.startsAt,
        consultationType: "in_person",
        offeringId: clinic.inPersonOfferingId,
        preferredLanguage: "fr",
        ...extra,
      },
      cookie,
    );
  const transition = (cookie: string, id: string, action: "confirm" | "cancel") =>
    harness.post(`/v1/appointments/${id}/${action}`, {}, cookie);

  beforeAll(async () => {
    harness = await createTestHarness(undefined, { now: NOW });
    await harness.db.insert(profession).values({
      id: PROFESSION_ID,
      nameEn: "Doctor",
      nameFr: "Médecin",
      prefixHint: "Dr.",
    });
    clinic = await setUpClinic(harness, "ap");

    patientA = await harness.signUpAndVerify("ap-a@example.com", "password12345", "Pat A");
    await completePatient(harness, patientA, "Tchamba", "Claire");
    patientB = await harness.signUpAndVerify("ap-b@example.com", "password12345", "Pat B");
    await completePatient(harness, patientB, "Fon", "Bernard");
    noProfile = await harness.signUpAndVerify("ap-c@example.com", "password12345", "No Profile");

    // A manages dependent D and is the active caregiver of linked account L.
    dependentId = (
      await json<{ id: string }>(
        await harness.post(
          "/v1/dependents",
          {
            surname: "Tchamba",
            givenNames: "Ariane",
            dateOfBirth: "2015-03-02",
            sex: "female",
            relationship: "child",
          },
          patientA,
        ),
      )
    ).id;
    linkedCookie = await harness.signUpAndVerify("ap-l@example.com", "password12345", "Linked");
    await completePatient(harness, linkedCookie, "Tchamba", "Rose");
    linkedUserId = await harness.userIdFor("ap-l@example.com");
    const invited = await harness.post(
      "/v1/dependents/invitations",
      { inviteeEmail: "ap-l@example.com", relationship: "parent" },
      patientA,
    );
    expect(invited.status).toBe(201);
    linkId = (await json<{ id: string }>(invited)).id;
    const invite = harness.sent
      .toReversed()
      .find((m) => m.to === "ap-l@example.com" && /accept/i.test(m.html));
    const token = invite?.html.match(UUID_RE)?.[0];
    if (token === undefined) throw new Error("no invitation token captured");
    expect((await harness.post(`/v1/invitations/${token}/accept`, {}, linkedCookie)).status).toBe(
      200,
    );

    slots = await slotsFor(harness, patientA, clinic.doctorId);
  });

  afterAll(() => harness.dispose());

  it("expands Monday 09:00–12:00 Douala into six 30-minute slots", () => {
    const monday = slots.filter((slot) => slot.startsAt.startsWith(MONDAY));
    expect(monday.map((slot) => slot.startsAt.slice(11, 16))).toEqual([
      "08:00",
      "08:30",
      "09:00",
      "09:30",
      "10:00",
      "10:30",
    ]);
  });

  it("holds a slot for the configured window and removes it from availability", async () => {
    const slot = slotAt(slots, `${MONDAY}T08:00:00.000Z`);
    const response = await hold(patientA, slot);
    expect(response.status).toBe(201);
    const held = await json<AppointmentBody>(response);
    expect(held.status).toBe("held");
    expect(held.holdExpiresAt).toBe(new Date(NOW.getTime() + 10 * 60_000).toISOString());
    expect(held.endsAt).toBe(slot.endsAt);
    // The slot's location travels with the rule when the client sends none.
    expect(held.locationId).toBe(clinic.locationId);
    expect(held.subject).toEqual({ kind: "self", dependentId: null, subjectUserId: null });

    const after = await slotsFor(harness, patientB, clinic.doctorId);
    expect(after.map((s) => s.startsAt)).not.toContain(slot.startsAt);
    const days = await json<{ data: ReadonlyArray<string> }>(
      await request(
        harness,
        "GET",
        `/v1/practitioners/${clinic.doctorId}/availability/days?month=2026-10`,
        patientB,
      ),
    );
    expect(days.data).toContain(MONDAY);
  });

  it("two patients racing for one slot: exactly one wins, the other gets SLOT_UNAVAILABLE", async () => {
    const slot = slotAt(slots, `${MONDAY}T08:30:00.000Z`);
    const [first, second] = await Promise.all([hold(patientA, slot), hold(patientB, slot)]);
    expect([first.status, second.status].toSorted()).toEqual([201, 409]);
    const loser = first.status === 409 ? first : second;
    expect((await json<ErrorBody>(loser)).error.code).toBe("SLOT_UNAVAILABLE");
  });

  it("refuses a slot that is not on the live schedule", async () => {
    const slot = slotAt(slots, `${MONDAY}T09:00:00.000Z`);
    const stale = await hold(patientA, { ...slot, startsAt: `${MONDAY}T09:05:00.000Z` });
    expect(stale.status).toBe(409);
    expect((await json<ErrorBody>(stale)).error.code).toBe("SLOT_UNAVAILABLE");
    const forged = await hold(patientA, {
      ...slot,
      key: `rule:${crypto.randomUUID()}:${slot.startsAt}`,
    });
    expect(forged.status).toBe(409);
  });

  it("confirms a hold (idempotently) and shows it on the doctor's agenda", async () => {
    const slot = slotAt(slots, `${MONDAY}T09:00:00.000Z`);
    const { id } = await json<AppointmentBody>(await hold(patientA, slot));
    const confirmed = await transition(patientA, id, "confirm");
    expect(confirmed.status).toBe(200);
    const body = await json<AppointmentBody>(confirmed);
    expect(body.status).toBe("confirmed");
    expect(body.holdExpiresAt).toBeNull();
    // A retried confirm after a dropped response is harmless.
    expect((await json<AppointmentBody>(await transition(patientA, id, "confirm"))).status).toBe(
      "confirmed",
    );

    const agenda = await json<{
      data: ReadonlyArray<{
        id: string;
        status: string;
        startsAt: string;
        patient: { kind: string; displayName: string };
        booker: { displayName: string };
        offering: { priceXaf: number };
        location: { label: string } | null;
      }>;
      meta: { date: string; count: number };
    }>(
      await request(
        harness,
        "GET",
        `/v1/practitioners/me/agenda?date=${MONDAY}`,
        clinic.doctorCookie,
      ),
    );
    expect(agenda.meta.date).toBe(MONDAY);
    const entry = agenda.data.find((e) => e.id === id);
    expect(entry).toMatchObject({
      status: "confirmed",
      patient: { kind: "self", displayName: "Claire Tchamba" },
      booker: { displayName: "Claire Tchamba" },
      offering: { priceXaf: 10_000 },
      location: { label: "Cabinet Bonanjo" },
    });
    // Still-live holds are on the agenda too, labelled as such, in time order.
    expect(agenda.data.map((e) => e.status)).toContain("held");
    const starts = agenda.data.map((e) => e.startsAt);
    expect(starts).toEqual([...starts].toSorted());
  });

  it("a lapsed hold no longer blocks the slot, and its confirm is HOLD_EXPIRED", async () => {
    const slot = slotAt(slots, `${MONDAY}T09:30:00.000Z`);
    const staleId = crypto.randomUUID();
    await harness.db.insert(appointment).values({
      id: staleId,
      practitionerProfileId: clinic.doctorId,
      bookerUserId: await harness.userIdFor("ap-a@example.com"),
      offeringId: clinic.inPersonOfferingId,
      consultationType: "in_person",
      locationId: clinic.locationId,
      startsAt: new Date(slot.startsAt),
      endsAt: new Date(slot.endsAt),
      slotKey: slot.key,
      preferredLanguage: "fr",
      status: "held",
      holdExpiresAt: new Date(NOW.getTime() - 60_000),
    });
    expect((await hold(patientB, slot)).status).toBe(201);

    const expired = await transition(patientA, staleId, "confirm");
    expect(expired.status).toBe(409);
    expect((await json<ErrorBody>(expired)).error.code).toBe("HOLD_EXPIRED");
    const shown = await json<AppointmentBody>(
      await request(harness, "GET", `/v1/appointments/${staleId}`, patientA),
    );
    expect(shown.status).toBe("expired");
  });

  it("re-holding your own slot returns the same hold without extending it", async () => {
    const slot = slotAt(slots, `${MONDAY}T10:00:00.000Z`);
    const first = await json<AppointmentBody>(await hold(patientA, slot));
    const retry = await hold(patientA, slot);
    expect(retry.status).toBe(201);
    const second = await json<AppointmentBody>(retry);
    expect(second.id).toBe(first.id);
    expect(second.holdExpiresAt).toBe(first.holdExpiresAt);
    expect(second.status).toBe("held");
    // …but the same slot for a DIFFERENT subject is a genuine collision.
    const forDependent = await hold(patientA, slot, { dependentId });
    expect(forDependent.status).toBe(409);
  });

  it("books a slot generated by an overnight rule that starts on the next calendar day", async () => {
    const overnight = slotAt(
      (
        await json<{ data: Slot[] }>(
          await request(
            harness,
            "GET",
            `/v1/practitioners/${clinic.doctorId}/availability?from=2026-10-02T00:00:00.000Z&to=2026-10-03T12:00:00.000Z`,
            patientA,
          ),
        )
      ).data,
      "2026-10-02T23:00:00.000Z",
    );
    expect((await hold(patientA, overnight)).status).toBe(201);
  });

  it("refuses bookings beyond the 60-day horizon", async () => {
    const slot = slotAt(slots, `${MONDAY}T10:00:00.000Z`);
    const far = await hold(patientA, {
      ...slot,
      key: slot.key.replace(MONDAY, "2027-01-04"),
      startsAt: "2027-01-04T08:00:00.000Z",
    });
    expect(far.status).toBe(422);
  });

  it("books on behalf of a managed dependent or a linked account only with an active link", async () => {
    const forDependent = await hold(patientA, slotAt(slots, `${MONDAY}T10:30:00.000Z`), {
      dependentId,
    });
    expect(forDependent.status).toBe(201);
    const dependentBooking = await json<AppointmentBody>(forDependent);
    expect(dependentBooking.subject).toEqual({
      kind: "dependent",
      dependentId,
      subjectUserId: null,
    });
    const agenda = await json<{
      data: ReadonlyArray<{
        id: string;
        patient: { kind: string; displayName: string };
        booker: { displayName: string };
      }>;
    }>(
      await request(
        harness,
        "GET",
        `/v1/practitioners/me/agenda?date=${MONDAY}`,
        clinic.doctorCookie,
      ),
    );
    expect(agenda.data.find((e) => e.id === dependentBooking.id)).toMatchObject({
      patient: { kind: "dependent", displayName: "Ariane Tchamba" },
      booker: { displayName: "Claire Tchamba" },
    });
    // Only the booker may confirm — not even the practitioner.
    expect((await transition(clinic.doctorCookie, dependentBooking.id, "confirm")).status).toBe(
      404,
    );

    const forLinked = await hold(patientA, slotAt(slots, "2026-10-06T08:00:00.000Z"), {
      subjectUserId: linkedUserId,
    });
    expect(forLinked.status).toBe(201);
    const linked = await json<AppointmentBody>(forLinked);
    expect(linked.subject.kind).toBe("linked");
    // The linked dependent sees it in their own list; B, who booked nothing, does not.
    const theirs = await json<{ data: ReadonlyArray<{ id: string }> }>(
      await request(harness, "GET", "/v1/me/appointments", linkedCookie),
    );
    expect(theirs.data.map((a) => a.id)).toContain(linked.id);
    const bList = await json<{ data: ReadonlyArray<{ id: string }> }>(
      await request(harness, "GET", "/v1/me/appointments", patientB),
    );
    expect(bList.data.map((a) => a.id)).not.toContain(linked.id);

    const stranger = await hold(patientB, slotAt(slots, "2026-10-06T08:30:00.000Z"), {
      dependentId,
    });
    expect(stranger.status).toBe(403);
    expect((await json<ErrorBody>(stranger)).error.code).toBe("NOT_A_CAREGIVER");
    expect(
      (
        await hold(patientB, slotAt(slots, "2026-10-06T08:30:00.000Z"), {
          subjectUserId: linkedUserId,
        })
      ).status,
    ).toBe(403);
    const both = await hold(patientA, slotAt(slots, "2026-10-06T08:30:00.000Z"), {
      dependentId,
      subjectUserId: linkedUserId,
    });
    expect(both.status).toBe(422);
  });

  it("requires a completed patient profile for the care subject", async () => {
    const response = await hold(noProfile, slotAt(slots, "2026-10-06T09:00:00.000Z"));
    expect(response.status).toBe(409);
    expect((await json<ErrorBody>(response)).error.code).toBe("PROFILE_INCOMPLETE");
  });

  it("requires the booker to have a profile even when booking for a dependent", async () => {
    // A brand-new account can create a dependent, but the doctor needs a named booker.
    const orphanDependent = (
      await json<{ id: string }>(
        await harness.post(
          "/v1/dependents",
          {
            surname: "Nkeng",
            givenNames: "Junior",
            dateOfBirth: "2018-01-01",
            sex: "male",
            relationship: "child",
          },
          noProfile,
        ),
      )
    ).id;
    const response = await hold(noProfile, slotAt(slots, "2026-10-06T09:00:00.000Z"), {
      dependentId: orphanDependent,
    });
    expect(response.status).toBe(409);
    expect((await json<ErrorBody>(response)).error.code).toBe("PROFILE_INCOMPLETE");
  });

  it("validates offering, language, and location against the practitioner", async () => {
    const slot = slotAt(slots, "2026-10-06T09:30:00.000Z");
    const wrongType = await hold(patientA, slot, { offeringId: clinic.videoOfferingId });
    expect(wrongType.status).toBe(422);
    expect((await hold(patientA, slot, { preferredLanguage: "de" })).status).toBe(422);
    expect((await hold(patientA, slot, { locationId: crypto.randomUUID() })).status).toBe(422);
    expect((await hold(patientA, slot, { offeringId: crypto.randomUUID() })).status).toBe(404);
    expect((await hold(patientA, slot, { practitionerId: crypto.randomUUID() })).status).toBe(404);
    expect((await hold(patientA, slot, { consultationType: "home_visit" })).status).toBe(422);
  });

  it("cancels (booker only, idempotent) and frees the slot; strangers get 404", async () => {
    const slot = slotAt(slots, "2026-10-06T10:00:00.000Z");
    const { id } = await json<AppointmentBody>(await hold(patientA, slot));
    await transition(patientA, id, "confirm");
    expect((await transition(patientB, id, "cancel")).status).toBe(404);
    expect((await request(harness, "GET", `/v1/appointments/${id}`, patientB)).status).toBe(404);
    // The practitioner is a party to it.
    expect(
      (await request(harness, "GET", `/v1/appointments/${id}`, clinic.doctorCookie)).status,
    ).toBe(200);

    const cancelled = await transition(patientA, id, "cancel");
    expect(cancelled.status).toBe(200);
    expect((await json<AppointmentBody>(cancelled)).status).toBe("cancelled");
    expect((await json<AppointmentBody>(await transition(patientA, id, "cancel"))).status).toBe(
      "cancelled",
    );
    const confirmAfter = await transition(patientA, id, "confirm");
    expect(confirmAfter.status).toBe(409);
    expect((await json<ErrorBody>(confirmAfter)).error.code).toBe("APPOINTMENT_STATE_INVALID");

    const after = await slotsFor(harness, patientB, clinic.doctorId);
    expect(after.map((s) => s.startsAt)).toContain(slot.startsAt);
  });

  it("flips an explicit slot open → booked on confirm and back on cancel", async () => {
    const published = await json<{ id: string }>(
      await harness.post(
        "/v1/practitioners/me/availability",
        {
          startsAt: "2026-10-06T14:00:00.000Z",
          endsAt: "2026-10-06T14:30:00.000Z",
          consultationTypes: ["video"],
        },
        clinic.doctorCookie,
      ),
    );
    const explicit = slotAt(
      await slotsFor(harness, patientA, clinic.doctorId),
      "2026-10-06T14:00:00.000Z",
    );
    expect(explicit.key).toBe(`explicit:${published.id}`);
    const { id } = await json<AppointmentBody>(
      await hold(patientA, explicit, {
        consultationType: "video",
        offeringId: clinic.videoOfferingId,
      }),
    );
    const statusOf = async (): Promise<string | undefined> =>
      (
        await json<{ data: ReadonlyArray<{ id: string; status: string }> }>(
          await request(
            harness,
            "GET",
            "/v1/practitioners/me/availability?limit=100",
            clinic.doctorCookie,
          ),
        )
      ).data.find((s) => s.id === published.id)?.status;
    expect(await statusOf()).toBe("open");
    expect((await transition(patientA, id, "confirm")).status).toBe(200);
    expect(await statusOf()).toBe("booked");
    expect((await transition(patientA, id, "cancel")).status).toBe(200);
    expect(await statusOf()).toBe("open");
  });

  it("books a video consultation on a rule slot that carries an in-person location", async () => {
    const slot = slotAt(slots, "2026-10-06T09:30:00.000Z");
    const response = await hold(patientA, slot, {
      consultationType: "video",
      offeringId: clinic.videoOfferingId,
    });
    expect(response.status).toBe(201);
    const held = await json<AppointmentBody>(response);
    expect(held.locationId).toBeNull();
    expect((await transition(patientA, held.id, "cancel")).status).toBe(200);
  });

  it("cancelling a merely held explicit slot leaves the slot open", async () => {
    const published = await json<{ id: string }>(
      await harness.post(
        "/v1/practitioners/me/availability",
        {
          startsAt: "2026-10-06T16:00:00.000Z",
          endsAt: "2026-10-06T16:30:00.000Z",
          consultationTypes: ["video"],
        },
        clinic.doctorCookie,
      ),
    );
    const explicit = slotAt(
      await slotsFor(harness, patientA, clinic.doctorId),
      "2026-10-06T16:00:00.000Z",
    );
    const { id } = await json<AppointmentBody>(
      await hold(patientA, explicit, {
        consultationType: "video",
        offeringId: clinic.videoOfferingId,
      }),
    );
    expect((await transition(patientA, id, "cancel")).status).toBe(200);
    const listed = await json<{ data: ReadonlyArray<{ id: string; status: string }> }>(
      await request(
        harness,
        "GET",
        "/v1/practitioners/me/availability?limit=100",
        clinic.doctorCookie,
      ),
    );
    expect(listed.data.find((s) => s.id === published.id)?.status).toBe("open");
    expect((await slotsFor(harness, patientB, clinic.doctorId)).map((s) => s.startsAt)).toContain(
      explicit.startsAt,
    );
  });

  it("paginates my appointments newest-first and rejects malformed cursors", async () => {
    const page = await json<{
      data: ReadonlyArray<{ id: string }>;
      meta: { hasNextPage: boolean; nextCursor: string | null };
    }>(await request(harness, "GET", "/v1/me/appointments?limit=2", patientA));
    expect(page.data).toHaveLength(2);
    expect(page.meta.hasNextPage).toBe(true);
    const next = await json<{ data: ReadonlyArray<{ id: string }> }>(
      await request(
        harness,
        "GET",
        `/v1/me/appointments?limit=2&cursor=${page.meta.nextCursor ?? ""}`,
        patientA,
      ),
    );
    expect(next.data.map((a) => a.id)).not.toContain(page.data[0]?.id);
    expect(
      (await request(harness, "GET", "/v1/me/appointments?cursor=nope", patientA)).status,
    ).toBe(422);
    expect((await request(harness, "GET", "/v1/me/appointments", undefined)).status).toBe(401);
  });

  it("releases the hold when the doctor withdraws an explicit slot before confirm", async () => {
    const published = await json<{ id: string }>(
      await harness.post(
        "/v1/practitioners/me/availability",
        {
          startsAt: "2026-10-06T15:00:00.000Z",
          endsAt: "2026-10-06T15:30:00.000Z",
          consultationTypes: ["video"],
        },
        clinic.doctorCookie,
      ),
    );
    const explicit = slotAt(
      await slotsFor(harness, patientA, clinic.doctorId),
      "2026-10-06T15:00:00.000Z",
    );
    const { id } = await json<AppointmentBody>(
      await hold(patientA, explicit, {
        consultationType: "video",
        offeringId: clinic.videoOfferingId,
      }),
    );
    expect(
      (
        await request(
          harness,
          "DELETE",
          `/v1/practitioners/me/availability/${published.id}`,
          clinic.doctorCookie,
        )
      ).status,
    ).toBe(204);
    const confirmed = await transition(patientA, id, "confirm");
    expect(confirmed.status).toBe(409);
    expect((await json<ErrorBody>(confirmed)).error.code).toBe("SLOT_UNAVAILABLE");
    const shown = await json<AppointmentBody>(
      await request(harness, "GET", `/v1/appointments/${id}`, patientA),
    );
    expect(shown.status).toBe("cancelled");
  });

  it("serializes simultaneous confirm retries and cannot resurrect a cancelled appointment", async () => {
    const published = await json<{ id: string }>(
      await harness.post(
        "/v1/practitioners/me/availability",
        {
          startsAt: "2026-10-06T17:00:00.000Z",
          endsAt: "2026-10-06T17:30:00.000Z",
          consultationTypes: ["video"],
        },
        clinic.doctorCookie,
      ),
    );
    const explicit = slotAt(
      await slotsFor(harness, patientB, clinic.doctorId),
      "2026-10-06T17:00:00.000Z",
    );
    const held = await json<AppointmentBody>(
      await hold(patientB, explicit, {
        consultationType: "video",
        offeringId: clinic.videoOfferingId,
      }),
    );
    const confirmations = await Promise.all([
      transition(patientB, held.id, "confirm"),
      transition(patientB, held.id, "confirm"),
    ]);
    expect(confirmations.map((response) => response.status)).toEqual([200, 200]);
    const confirmed = await json<AppointmentBody>(confirmations[0] ?? new Response());
    expect(confirmed.revision).toBe(held.revision + 1);
    const races = await Promise.all([
      transition(patientB, held.id, "cancel"),
      transition(patientB, held.id, "confirm"),
    ]);
    expect(races[0]?.status).toBe(200);
    const final = await json<AppointmentBody>(
      await request(harness, "GET", `/v1/appointments/${held.id}`, patientB),
    );
    expect(final.status).toBe("cancelled");
    expect(final.revision).toBe(confirmed.revision + 1);
    const available = await slotsFor(harness, patientB, clinic.doctorId);
    expect(
      available
        .filter((slot) => slot.key === `explicit:${published.id}`)
        .map((slot) => slot.startsAt),
    ).toEqual([explicit.startsAt]);
  });

  it("snapshots cancellation terms and lets only the practitioner change policy", async () => {
    const endpoint = "/v1/practitioners/me/booking-policy";
    expect(
      (await request(harness, "PATCH", endpoint, patientB, { cancellationCutoffHours: 168 }))
        .status,
    ).toBe(403);
    expect(
      (
        await request(harness, "PATCH", endpoint, clinic.doctorCookie, {
          cancellationCutoffHours: -1,
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await request(harness, "PATCH", endpoint, clinic.doctorCookie, {
          cancellationCutoffHours: 0,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(
          harness,
          "GET",
          `/v1/practitioners/${clinic.doctorId}/booking-policy`,
          undefined,
        )
      ).status,
    ).toBe(401);
    const publicPolicy = await json<{ cancellationCutoffHours: number }>(
      await request(
        harness,
        "GET",
        `/v1/practitioners/${clinic.doctorId}/booking-policy`,
        patientB,
      ),
    );
    expect(publicPolicy.cancellationCutoffHours).toBe(0);
    const published = await json<{ id: string }>(
      await harness.post(
        "/v1/practitioners/me/availability",
        {
          startsAt: "2026-10-06T18:00:00.000Z",
          endsAt: "2026-10-06T18:30:00.000Z",
          consultationTypes: ["video"],
        },
        clinic.doctorCookie,
      ),
    );
    const slot = slotAt(
      await slotsFor(harness, patientB, clinic.doctorId),
      "2026-10-06T18:00:00.000Z",
    );
    const held = await json<AppointmentBody>(
      await hold(patientB, slot, { consultationType: "video", offeringId: clinic.videoOfferingId }),
    );
    expect((await transition(patientB, held.id, "confirm")).status).toBe(200);
    expect(
      (
        await request(harness, "PATCH", endpoint, clinic.doctorCookie, {
          cancellationCutoffHours: 168,
        })
      ).status,
    ).toBe(200);
    expect((await transition(patientB, held.id, "cancel")).status).toBe(200);
    const available = await slotsFor(harness, patientB, clinic.doctorId);
    expect(
      available.filter((candidate) => candidate.key === `explicit:${published.id}`),
    ).toHaveLength(1);
    const next = await json<AppointmentBody>(
      await hold(patientB, slot, { consultationType: "video", offeringId: clinic.videoOfferingId }),
    );
    expect((await transition(patientB, next.id, "confirm")).status).toBe(200);
    expect((await transition(patientB, next.id, "cancel")).status).toBe(409);
    const refusedMove = await harness.post(
      `/v1/appointments/${next.id}/reschedule`,
      {
        operationId: uuidv7(),
        expectedRevision: next.revision + 1,
        slotKey: slot.key,
        startsAt: slot.startsAt,
      },
      patientB,
    );
    expect(refusedMove.status).toBe(409);
    expect((await json<ErrorBody>(refusedMove)).error.code).toBe("CANCELLATION_WINDOW_CLOSED");
    expect(
      (
        await request(harness, "PATCH", endpoint, clinic.doctorCookie, {
          cancellationCutoffHours: null,
        })
      ).status,
    ).toBe(200);
  });

  it("agenda is practitioner-only and defaults to today", async () => {
    expect((await request(harness, "GET", "/v1/practitioners/me/agenda", patientA)).status).toBe(
      403,
    );
    const today = await json<{ meta: { date: string; count: number } }>(
      await request(harness, "GET", "/v1/practitioners/me/agenda", clinic.doctorCookie),
    );
    expect(today.meta.date).toBe("2026-10-02");
  });

  // Last: it revokes the caregiver link the earlier on-behalf tests rely on.
  it("re-checks the caregiver link at confirm time", async () => {
    const held = await json<AppointmentBody>(
      await hold(patientA, slotAt(slots, "2026-10-06T10:30:00.000Z"), {
        subjectUserId: linkedUserId,
      }),
    );
    expect(
      (await request(harness, "DELETE", `/v1/dependents/links/${linkId}`, linkedCookie)).status,
    ).toBe(204);
    const confirmed = await transition(patientA, held.id, "confirm");
    expect(confirmed.status).toBe(403);
    expect((await json<ErrorBody>(confirmed)).error.code).toBe("NOT_A_CAREGIVER");
  });
});

describe("appointments API — configured hold TTL and cancellation cutoff", () => {
  let harness: TestHarness;
  let clinic: Clinic;
  let patient: string;

  beforeAll(async () => {
    harness = await createTestHarness(
      {
        APPOINTMENT_HOLD_TTL_MINUTES: "3",
        APPOINTMENT_CANCEL_CUTOFF_HOURS: "48",
        APPOINTMENT_MAX_LIVE_PER_BOOKER: "2",
      },
      { now: NOW },
    );
    await harness.db.insert(profession).values({
      id: PROFESSION_ID,
      nameEn: "Doctor",
      nameFr: "Médecin",
      prefixHint: "Dr.",
    });
    clinic = await setUpClinic(harness, "cfg");
    patient = await harness.signUpAndVerify("cfg-p@example.com", "password12345", "Pat");
    await completePatient(harness, patient, "Mbeki", "Ama");
  });

  afterAll(() => harness.dispose());

  it("honours the hold TTL, the cancellation cutoff, and the per-booker live cap", async () => {
    const listed = async (window: string): Promise<Slot[]> =>
      (
        await json<{ data: Slot[] }>(
          await request(
            harness,
            "GET",
            `/v1/practitioners/${clinic.doctorId}/availability?${window}`,
            patient,
          ),
        )
      ).data;
    const book = (slot: Slot): Promise<Response> =>
      harness.post(
        "/v1/appointments",
        {
          practitionerId: clinic.doctorId,
          slotKey: slot.key,
          startsAt: slot.startsAt,
          consultationType: "in_person",
          offeringId: clinic.inPersonOfferingId,
          preferredLanguage: "en",
        },
        patient,
      );
    const FRIDAY = "from=2026-10-02T00:00:00.000Z&to=2026-10-03T00:00:00.000Z";
    const monday = await listed(WINDOW);
    const eight = slotAt(monday, `${MONDAY}T08:00:00.000Z`);
    const eightThirty = slotAt(monday, `${MONDAY}T08:30:00.000Z`);

    // Friday 2026-10-02 08:00Z is 20 h after NOW — inside the 48 h cutoff.
    const soonResponse = await book(slotAt(await listed(FRIDAY), "2026-10-02T08:00:00.000Z"));
    expect(soonResponse.status).toBe(201);
    const soon = await json<AppointmentBody>(soonResponse);
    expect(soon.holdExpiresAt).toBe(new Date(NOW.getTime() + 3 * 60_000).toISOString());
    expect((await harness.post(`/v1/appointments/${soon.id}/confirm`, {}, patient)).status).toBe(
      200,
    );
    const refused = await harness.post(`/v1/appointments/${soon.id}/cancel`, {}, patient);
    expect(refused.status).toBe(409);
    expect((await json<ErrorBody>(refused)).error.code).toBe("CANCELLATION_WINDOW_CLOSED");

    // Monday is four days out — cancellable. That's two live holds: the cap.
    const laterResponse = await book(eight);
    expect(laterResponse.status).toBe(201);
    const later = await json<AppointmentBody>(laterResponse);
    const capped = await book(eightThirty);
    expect(capped.status).toBe(409);
    expect((await json<ErrorBody>(capped)).error.code).toBe("BOOKING_LIMIT_REACHED");
    // Retrying an existing hold is not a new booking, so it is exempt from the cap.
    expect((await book(eight)).status).toBe(201);

    expect((await harness.post(`/v1/appointments/${later.id}/cancel`, {}, patient)).status).toBe(
      200,
    );
    expect((await book(eightThirty)).status).toBe(201);
  });
});

describe("appointments API — atomic rescheduling", () => {
  let harness: TestHarness;
  let clinic: Clinic;
  let patient: string;
  let other: string;
  const publish = async (hour: number): Promise<Slot> => {
    const startsAt = `2026-10-06T${hour}:00:00.000Z`;
    const endsAt = `2026-10-06T${hour}:30:00.000Z`;
    const response = await harness.post(
      "/v1/practitioners/me/availability",
      { startsAt, endsAt, consultationTypes: ["video"] },
      clinic.doctorCookie,
    );
    expect(response.status).toBe(201);
    const body = await json<{ id: string }>(response);
    return {
      key: `explicit:${body.id}`,
      startsAt,
      endsAt,
      consultationTypes: ["video"],
      locationId: null,
    };
  };
  const book = async (slot: Slot, cookie = patient): Promise<AppointmentBody> => {
    const held = await harness.post(
      "/v1/appointments",
      {
        practitionerId: clinic.doctorId,
        slotKey: slot.key,
        startsAt: slot.startsAt,
        consultationType: "video",
        offeringId: clinic.videoOfferingId,
        preferredLanguage: "fr",
      },
      cookie,
    );
    expect(held.status).toBe(201);
    const created = await json<AppointmentBody>(held);
    const confirmed = await harness.post(`/v1/appointments/${created.id}/confirm`, {}, cookie);
    expect(confirmed.status).toBe(200);
    return json<AppointmentBody>(confirmed);
  };
  const move = (found: AppointmentBody, slot: Slot, operationId = uuidv7(), cookie = patient) =>
    harness.post(
      `/v1/appointments/${found.id}/reschedule`,
      { operationId, expectedRevision: found.revision, slotKey: slot.key, startsAt: slot.startsAt },
      cookie,
    );
  const get = (id: string, cookie = patient) =>
    request(harness, "GET", `/v1/appointments/${id}`, cookie);
  beforeAll(async () => {
    harness = await createTestHarness(undefined, { now: NOW });
    await harness.db
      .insert(profession)
      .values({ id: PROFESSION_ID, nameEn: "Doctor", nameFr: "Médecin", prefixHint: "Dr." });
    clinic = await setUpClinic(harness, "move");
    patient = await harness.signUpAndVerify("move-p@example.com", "password12345", "Patient");
    other = await harness.signUpAndVerify("move-other@example.com", "password12345", "Other");
    await completePatient(harness, patient, "Tchamba", "Claire");
    await completePatient(harness, other, "Fon", "Bernard");
  });
  afterAll(() => harness.dispose());

  it("moves the same appointment, releases the source, and replays its immutable response after later changes", async () => {
    const source = await publish(13);
    const first = await publish(14);
    const second = await publish(15);
    const original = await book(source);
    const noOp = await move(original, source);
    expect(noOp.status).toBe(200);
    expect((await json<AppointmentBody>(noOp)).revision).toBe(original.revision);
    const alternatives = await json<{ data: Slot[]; meta: { nextCursor: string | null } }>(
      await request(
        harness,
        "GET",
        `/v1/appointments/${original.id}/alternatives?from=2026-10-06T13:00:00.000Z&to=2026-10-06T16:00:00.000Z&limit=1`,
        patient,
      ),
    );
    expect(alternatives.data.map((slot) => slot.key)).toEqual([first.key]);
    const next = await json<{ data: Slot[] }>(
      await request(
        harness,
        "GET",
        `/v1/appointments/${original.id}/alternatives?from=2026-10-06T13:00:00.000Z&to=2026-10-06T16:00:00.000Z&limit=1&cursor=${encodeURIComponent(alternatives.meta.nextCursor ?? "")}`,
        patient,
      ),
    );
    expect(next.data.map((slot) => slot.key)).toEqual([second.key]);
    const operationId = uuidv7();
    const response = await move(original, first, operationId);
    expect(response.status).toBe(200);
    const moved = await json<AppointmentBody>(response);
    expect(moved.id).toBe(original.id);
    expect(moved.startsAt).toBe(first.startsAt);
    expect(moved.revision).toBe(original.revision + 1);
    expect(
      (await slotsFor(harness, patient, clinic.doctorId)).filter((slot) => slot.key === source.key),
    ).toHaveLength(1);
    const laterResponse = await move(moved, second);
    expect(laterResponse.status).toBe(200);
    const later = await json<AppointmentBody>(laterResponse);
    expect(await json<AppointmentBody>(await move(original, first, operationId))).toEqual(moved);
    // Omitted and explicit-null fields are distinct requests: a replay must not
    // silently accept a payload that differs from the successful operation.
    const changedPayload = await harness.post(
      `/v1/appointments/${original.id}/reschedule`,
      {
        operationId,
        expectedRevision: original.revision,
        slotKey: first.key,
        startsAt: first.startsAt,
        locationId: null,
      },
      patient,
    );
    expect(changedPayload.status).toBe(409);
    expect((await json<ErrorBody>(changedPayload)).error.code).toBe("CONFLICT");
    expect((await json<AppointmentBody>(await get(original.id))).startsAt).toBe(second.startsAt);
    expect((await move(original, source)).status).toBe(409);
    expect((await move(original, second, operationId)).status).toBe(409);
    expect(
      (
        await request(
          harness,
          "GET",
          `/v1/appointments/${original.id}/alternatives?${WINDOW}`,
          other,
        )
      ).status,
    ).toBe(404);
    expect((await move(later, source, uuidv7(), other)).status).toBe(404);
    expect((await harness.post(`/v1/appointments/${later.id}/cancel`, {}, patient)).status).toBe(
      200,
    );
  });

  it("two simultaneous moves to one destination leave the losing original reservation intact", async () => {
    const sourceA = await publish(16);
    const sourceB = await publish(17);
    const target = await publish(18);
    const a = await book(sourceA);
    const b = await book(sourceB, other);
    const responses = await Promise.all([move(a, target), move(b, target, uuidv7(), other)]);
    expect(responses.map((response) => response.status).toSorted()).toEqual([200, 409]);
    const aNow = await json<AppointmentBody>(await get(a.id));
    const bNow = await json<AppointmentBody>(await get(b.id, other));
    expect([aNow, bNow].filter((found) => found.startsAt === target.startsAt)).toHaveLength(1);
    const loser = responses[0]?.status === 409 ? aNow : bNow;
    const loserOriginal = responses[0]?.status === 409 ? a : b;
    expect(loser.startsAt).toBe(loserOriginal.startsAt);
    expect(loser.revision).toBe(loserOriginal.revision);
  });

  it("rolls back a claimed destination and the appointment move when recording history fails", async () => {
    const source = await publish(19);
    const target = await publish(20);
    const found = await book(source);
    const operationId = "019a0130-0000-7000-8000-000000000999";
    await harness.db.execute(
      sql`alter table appointment_change add constraint reject_test_operation check (id <> '019a0130-0000-7000-8000-000000000999'::uuid)`,
    );
    const response = await move(found, target, operationId).finally(() =>
      harness.db.execute(sql`alter table appointment_change drop constraint reject_test_operation`),
    );
    expect(response.status).toBe(500);
    const unchanged = await json<AppointmentBody>(await get(found.id));
    expect(unchanged.startsAt).toBe(source.startsAt);
    expect(unchanged.revision).toBe(found.revision);
    const open = await slotsFor(harness, patient, clinic.doctorId);
    expect(open.filter((slot) => slot.key === source.key)).toHaveLength(0);
    expect(open.filter((slot) => slot.key === target.key)).toHaveLength(1);
    expect((await move(found, target, operationId)).status).toBe(200);
  });
  it("retires an expired destination hold while preserving its expiry and moves into the freed slot", async () => {
    const source = await publish(21);
    const target = await publish(22);
    const found = await book(source);
    const targetHold = await json<AppointmentBody>(
      await harness.post(
        "/v1/appointments",
        {
          practitionerId: clinic.doctorId,
          slotKey: target.key,
          startsAt: target.startsAt,
          consultationType: "video",
          offeringId: clinic.videoOfferingId,
          preferredLanguage: "fr",
        },
        other,
      ),
    );
    const expiredAt = new Date(NOW.getTime() - 1);
    await harness.db
      .update(appointment)
      .set({ holdExpiresAt: expiredAt })
      .where(eq(appointment.id, targetHold.id));
    expect((await move(found, target)).status).toBe(200);
    const oldHold = await json<AppointmentBody>(await get(targetHold.id, other));
    expect(oldHold.status).toBe("expired");
    expect(oldHold.holdExpiresAt).toBe(expiredAt.toISOString());
    expect(
      (await harness.post(`/v1/appointments/${targetHold.id}/confirm`, {}, other)).status,
    ).toBe(409);
  });
});
