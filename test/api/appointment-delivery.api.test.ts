import { eq, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { appointment } from "@/db/schema/appointment";
import { user } from "@/db/schema/auth";
import { availabilitySlot } from "@/db/schema/availability-slot";
import { notificationDelivery } from "@/db/schema/notification-delivery";
import { notificationPreference } from "@/db/schema/notification-preference";
import { practitionerProfile } from "@/db/schema/practitioner-profile";
import { profession } from "@/db/schema/profession";
import { profile } from "@/db/schema/profile";
import { pushSubscription } from "@/db/schema/push-subscription";
import { createTestHarness, type TestHarness } from "../support/app-harness";

const NOW = new Date("2026-10-01T10:00:00.000Z");
const START = "2026-10-06T10:00:00.000Z";
const PATIENT_EMAIL = "delivery-patient@example.com";
const DOCTOR_EMAIL = "delivery-doctor@example.com";
const AppointmentBody = z.object({
  id: z.uuid(),
  revision: z.number().int(),
  status: z.string(),
  startsAt: z.string(),
});
const Event = z.object({ event: z.enum(["confirmed", "cancelled", "rescheduled", "reminder"]) });
const resource = async (response: Response) => AppointmentBody.parse(await response.json());
type AppointmentBody = z.infer<typeof AppointmentBody>;

// Real HTTP lifecycle + Postgres outbox + worker + capturing transports. The
// provider mailbox, persisted states and clock boundaries are independent
// observations; removing lifecycle enqueue or suppression turns these red.
describe("appointment delivery through the API and durable worker", () => {
  let harness: TestHarness;
  let patient: string;
  let doctor: string;
  let practitionerId: string;
  let offeringId: string;
  let emailStart: number;
  let pushStart: number;

  const request = (
    method: string,
    path: string,
    cookie: string,
    body?: {
      readonly preferences: ReadonlyArray<{
        readonly category: string;
        readonly email: boolean;
        readonly sms: boolean;
        readonly push: boolean;
      }>;
    },
  ) =>
    harness.app.request(path, {
      method,
      headers: body === undefined ? { cookie } : { cookie, "content-type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  const prefs = async (email: boolean, push: boolean) => {
    expect(
      (
        await request("PATCH", "/v1/me/notifications", patient, {
          preferences: [{ category: "appointments", email, sms: false, push }],
        })
      ).status,
    ).toBe(200);
  };
  const emails = () => harness.sent.slice(emailStart);
  const pushes = () => harness.sentPush.slice(pushStart);
  const jobs = (id: string) =>
    harness.db
      .select()
      .from(notificationDelivery)
      .where(eq(notificationDelivery.appointmentId, id));
  const publish = async (startsAt = START) => {
    const end = new Date(new Date(startsAt).getTime() + 30 * 60_000).toISOString();
    const response = await harness.post(
      "/v1/practitioners/me/availability",
      { startsAt, endsAt: end, consultationTypes: ["video"] },
      doctor,
    );
    expect(response.status).toBe(201);
    return z.object({ id: z.uuid() }).parse(await response.json()).id;
  };
  const hold = async (slotId: string, startsAt = START) => {
    const response = await harness.post(
      "/v1/appointments",
      {
        practitionerId,
        slotKey: `explicit:${slotId}`,
        startsAt,
        consultationType: "video",
        offeringId,
        preferredLanguage: "fr",
      },
      patient,
    );
    expect(response.status).toBe(201);
    return resource(response);
  };
  const confirm = (id: string) => harness.post(`/v1/appointments/${id}/confirm`, {}, patient);
  const cancel = (id: string) => harness.post(`/v1/appointments/${id}/cancel`, {}, patient);
  const move = (found: AppointmentBody, slotId: string, startsAt: string, operationId = uuidv7()) =>
    harness.post(
      `/v1/appointments/${found.id}/reschedule`,
      {
        operationId,
        expectedRevision: found.revision,
        slotKey: `explicit:${slotId}`,
        startsAt,
      },
      patient,
    );
  const get = async (id: string) =>
    resource(await request("GET", `/v1/appointments/${id}`, patient));
  const book = async () => {
    const slotId = await publish();
    const held = await hold(slotId);
    const response = await confirm(held.id);
    expect(response.status).toBe(200);
    return { found: await resource(response), slotId };
  };

  beforeAll(async () => {
    harness = await createTestHarness(undefined, { now: NOW });
    patient = await harness.signUpAndVerify(PATIENT_EMAIL, "password12345", "Claire");
    doctor = await harness.signUpAndVerify(DOCTOR_EMAIL, "password12345", "Marie");
    const patientUserId = await harness.userIdFor(PATIENT_EMAIL);
    const doctorUserId = await harness.userIdFor(DOCTOR_EMAIL);
    await harness.db.update(user).set({ locale: "fr" }).where(eq(user.id, patientUserId));
    await harness.db
      .update(user)
      .set({ role: "doctor", locale: "en" })
      .where(eq(user.id, doctorUserId));
    expect(
      (
        await harness.post(
          "/v1/patients/me/profile",
          {
            surname: "Tchamba",
            givenNames: "Claire",
            dateOfBirth: "1985-06-15",
            sex: "female",
            consentVersion: "1.0",
            acceptTerms: true,
          },
          patient,
        )
      ).status,
    ).toBe(200);
    const professionId = uuidv7();
    practitionerId = uuidv7();
    await harness.db
      .insert(profession)
      .values({ id: professionId, nameEn: "Doctor", nameFr: "Médecin", prefixHint: "Dr." });
    await harness.db.insert(profile).values({
      id: uuidv7(),
      userId: doctorUserId,
      surname: "Ngassa",
      givenNames: "Marie",
      consentAcceptedAt: NOW,
      consentVersion: "1.0",
    });
    await harness.db.insert(practitionerProfile).values({
      id: practitionerId,
      userId: doctorUserId,
      professionId,
      verificationStatus: "verified",
      languagesSpoken: ["fr", "en"],
      consultationTypes: ["video"],
    });
    const offering = await harness.post(
      "/v1/practitioners/me/offerings",
      { consultationType: "video", durationMin: 30, priceXaf: 8_000 },
      doctor,
    );
    expect(offering.status).toBe(201);
    offeringId = z.object({ id: z.uuid() }).parse(await offering.json()).id;
  });
  beforeEach(async () => {
    harness.advanceNow(NOW);
    await harness.db.delete(notificationDelivery);
    await harness.db.delete(appointment);
    await harness.db.delete(availabilitySlot);
    await harness.db.delete(pushSubscription);
    await harness.db.delete(notificationPreference);
    emailStart = harness.sent.length;
    pushStart = harness.sentPush.length;
  });
  afterAll(() => harness.dispose());

  it("enqueues once on confirmation, sends localized receipts and dispatches at exactly 24h and 1h", async () => {
    const slotId = await publish();
    const held = await hold(slotId);
    expect(await jobs(held.id)).toEqual([]);
    const response = await confirm(held.id);
    expect(response.status).toBe(200);
    const found = await resource(response);
    const queued = await jobs(found.id);
    expect(queued.filter((job) => Event.parse(job.snapshot).event === "confirmed")).toHaveLength(2);
    expect(
      queued
        .filter((job) => Event.parse(job.snapshot).event === "reminder")
        .map((job) => job.dueAt.toISOString())
        .toSorted(),
    ).toEqual([
      "2026-10-05T10:00:00.000Z",
      "2026-10-05T10:00:00.000Z",
      "2026-10-06T09:00:00.000Z",
      "2026-10-06T09:00:00.000Z",
    ]);
    expect(emails()).toEqual([]);
    expect((await confirm(found.id)).status).toBe(200);
    expect((await jobs(found.id)).map((job) => job.dedupeKey).toSorted()).toEqual(
      queued.map((job) => job.dedupeKey).toSorted(),
    );
    expect(await harness.runDeliveryPass()).toBe(2);
    expect(
      emails()
        .map((message) => [message.to, message.subject])
        .toSorted(),
    ).toEqual([
      [DOCTOR_EMAIL, "Appointment confirmed"],
      [PATIENT_EMAIL, "Rendez-vous confirmé"],
    ]);
    expect(emails().map((message) => message.html.includes("11:00"))).toEqual([true, true]);
    expect((await jobs(found.id)).filter((job) => job.state === "accepted")).toHaveLength(2);
    harness.advanceNow(new Date("2026-10-05T09:59:59.999Z"));
    expect(await harness.runDeliveryPass()).toBe(0);
    harness.advanceNow(new Date("2026-10-05T10:00:00.000Z"));
    expect(await harness.runDeliveryPass()).toBe(2);
    expect(
      emails()
        .slice(2)
        .map((message) => message.subject)
        .toSorted(),
    ).toEqual(["Appointment reminder", "Rappel de rendez-vous"]);
    harness.advanceNow(new Date("2026-10-06T08:59:59.999Z"));
    expect(await harness.runDeliveryPass()).toBe(0);
    harness.advanceNow(new Date("2026-10-06T09:00:00.000Z"));
    expect(await harness.runDeliveryPass()).toBe(2);
    expect(emails()).toHaveLength(6);
    expect(await harness.runDeliveryPass()).toBe(0);
    expect(emails()).toHaveLength(6);
  });

  it("rescheduling and cancellation invalidate prior receipts/reminders, including replayed requests", async () => {
    const { found } = await book();
    const targetAt = "2026-10-07T11:00:00.000Z";
    const target = await publish(targetAt);
    const operationId = uuidv7();
    const response = await move(found, target, targetAt, operationId);
    expect(response.status).toBe(200);
    const moved = await resource(response);
    expect(
      (await jobs(found.id)).filter(
        (job) => job.revision === found.revision && job.state !== "suppressed",
      ),
    ).toEqual([]);
    expect(
      (await jobs(found.id))
        .filter(
          (job) =>
            job.revision === moved.revision && Event.parse(job.snapshot).event === "reminder",
        )
        .map((job) => job.dueAt.toISOString())
        .toSorted(),
    ).toEqual([
      "2026-10-06T11:00:00.000Z",
      "2026-10-06T11:00:00.000Z",
      "2026-10-07T10:00:00.000Z",
      "2026-10-07T10:00:00.000Z",
    ]);
    const count = (await jobs(found.id)).length;
    expect((await move(found, target, targetAt, operationId)).status).toBe(200);
    expect((await jobs(found.id)).length).toBe(count);
    expect((await cancel(found.id)).status).toBe(200);
    expect((await cancel(found.id)).status).toBe(200);
    expect(
      (await jobs(found.id)).filter((job) => Event.parse(job.snapshot).event === "cancelled"),
    ).toHaveLength(2);
    expect(await harness.runDeliveryPass()).toBe(2);
    expect(
      emails()
        .map((message) => message.subject)
        .toSorted(),
    ).toEqual(["Appointment cancelled", "Rendez-vous annulé"]);
    harness.advanceNow(new Date("2026-10-05T10:00:00.000Z"));
    expect(await harness.runDeliveryPass()).toBe(0);
    harness.advanceNow(new Date("2026-10-07T10:00:00.000Z"));
    expect(await harness.runDeliveryPass()).toBe(0);
    expect(emails()).toHaveLength(2);
  });

  it("reads current email preferences at send time without suppressing the practitioner's notifications", async () => {
    const { found } = await book();
    await prefs(false, false);
    await harness.runDeliveryPass();
    expect(emails().map((message) => message.to)).toEqual([DOCTOR_EMAIL]);
    harness.advanceNow(new Date("2026-10-05T10:00:00.000Z"));
    await harness.runDeliveryPass();
    expect(emails().map((message) => message.to)).toEqual([DOCTOR_EMAIL, DOCTOR_EMAIL]);
    await prefs(true, false);
    harness.advanceNow(new Date("2026-10-06T09:00:00.000Z"));
    await harness.runDeliveryPass();
    expect(
      emails()
        .slice(2)
        .map((message) => message.to)
        .toSorted(),
    ).toEqual([DOCTOR_EMAIL, PATIENT_EMAIL]);
    const patientUserId = await harness.userIdFor(PATIENT_EMAIL);
    expect(
      (await jobs(found.id)).filter(
        (job) => job.recipientUserId === patientUserId && job.state === "suppressed",
      ),
    ).toHaveLength(2);
  });

  it("device registration preserves default push opt-out; enabling and removing a device controls delivery", async () => {
    const registration = await harness.post(
      "/v1/me/push-subscriptions",
      {
        endpoint: "https://fcm.googleapis.com/fcm/send/kanasante-delivery-test",
        keys: { p256dh: `B${"A".repeat(86)}`, auth: "A".repeat(22) },
      },
      patient,
    );
    expect(registration.status).toBe(200);
    const subscription = z
      .object({ id: z.uuid(), endpoint: z.string() })
      .parse(await registration.json());
    const { found } = await book();
    await harness.runDeliveryPass();
    expect(pushes()).toEqual([]);
    await prefs(true, true);
    const targetAt = "2026-10-07T11:00:00.000Z";
    const target = await publish(targetAt);
    expect((await move(found, target, targetAt)).status).toBe(200);
    await harness.runDeliveryPass();
    expect(pushes().map((message) => message.subscription.endpoint)).toEqual([
      subscription.endpoint,
    ]);
    expect(pushes()[0]?.payload).toContain(found.id);
    expect(
      (await request("DELETE", `/v1/me/push-subscriptions/${subscription.id}`, patient)).status,
    ).toBe(204);
    harness.advanceNow(new Date("2026-10-06T11:00:00.000Z"));
    await harness.runDeliveryPass();
    expect(pushes()).toHaveLength(1);
  });

  it("a failed outbox write rolls back confirmation and a later reschedule, preserving the original reservation", async () => {
    const source = await publish();
    const held = await hold(source);
    await harness.db.execute(
      sql`alter table notification_delivery add constraint reject_delivery_test_event check (snapshot->>'event' <> 'confirmed')`,
    );
    const rejected = await confirm(held.id).finally(() =>
      harness.db.execute(
        sql`alter table notification_delivery drop constraint reject_delivery_test_event`,
      ),
    );
    expect(rejected.status).toBe(500);
    expect(await get(held.id)).toEqual(held);
    expect(await jobs(held.id)).toEqual([]);
    expect(
      (await harness.db.select().from(availabilitySlot).where(eq(availabilitySlot.id, source)))[0]
        ?.status,
    ).toBe("open");
    const confirmedResponse = await confirm(held.id);
    expect(confirmedResponse.status).toBe(200);
    const confirmed = await resource(confirmedResponse);
    const before = await jobs(held.id);
    const targetAt = "2026-10-07T11:00:00.000Z";
    const target = await publish(targetAt);
    await harness.db.execute(
      sql`alter table notification_delivery add constraint reject_delivery_test_event check (snapshot->>'event' <> 'rescheduled')`,
    );
    const rejectedMove = await move(confirmed, target, targetAt).finally(() =>
      harness.db.execute(
        sql`alter table notification_delivery drop constraint reject_delivery_test_event`,
      ),
    );
    expect(rejectedMove.status).toBe(500);
    expect(await get(held.id)).toEqual(confirmed);
    expect((await jobs(held.id)).map((job) => [job.dedupeKey, job.state]).toSorted()).toEqual(
      before.map((job) => [job.dedupeKey, job.state]).toSorted(),
    );
    expect(
      (await harness.db.select().from(availabilitySlot).where(eq(availabilitySlot.id, source)))[0]
        ?.status,
    ).toBe("booked");
    expect(
      (await harness.db.select().from(availabilitySlot).where(eq(availabilitySlot.id, target)))[0]
        ?.status,
    ).toBe("open");
    expect((await move(confirmed, target, targetAt)).status).toBe(200);
  });

  it("backfills only future reminders and repeated passes cannot recreate receipts or duplicate delivery", async () => {
    const { found } = await book();
    // Simulate a confirmed booking that predates the outbox rollout.
    await harness.db
      .delete(notificationDelivery)
      .where(eq(notificationDelivery.appointmentId, found.id));
    expect((await harness.backfillDelivery({ limit: 1 })).count).toBe(1);
    const first = await jobs(found.id);
    expect(first.filter((job) => Event.parse(job.snapshot).event !== "reminder")).toEqual([]);
    expect(first).toHaveLength(4);
    await harness.backfillDelivery({ limit: 1 });
    expect((await jobs(found.id)).map((job) => job.dedupeKey).toSorted()).toEqual(
      first.map((job) => job.dedupeKey).toSorted(),
    );
    expect(await harness.runDeliveryPass()).toBe(0);
    expect(emails()).toEqual([]);
    harness.advanceNow(new Date("2026-10-05T10:00:00.000Z"));
    expect(await harness.runDeliveryPass()).toBe(2);
    expect(
      emails()
        .map((message) => message.subject)
        .toSorted(),
    ).toEqual(["Appointment reminder", "Rappel de rendez-vous"]);
  });
});
