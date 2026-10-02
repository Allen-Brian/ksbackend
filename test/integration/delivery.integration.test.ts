import { SqlClient } from "@effect/sql";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { appointment } from "@/db/schema/appointment";
import { user } from "@/db/schema/auth";
import { consultationOffering } from "@/db/schema/consultation-offering";
import { notificationDelivery } from "@/db/schema/notification-delivery";
import { practitionerProfile } from "@/db/schema/practitioner-profile";
import { profession } from "@/db/schema/profession";
import { DeliveryRepo, DeliveryRepoLive } from "@/modules/delivery/delivery.repo";
import { databaseLayerFromUrl, startTestPostgres } from "../support/testcontainers";

const id = (suffix: string) => `019a0000-0000-7000-8000-${suffix.padStart(12, "0")}`;
const instant = (millis: number) => new Date(millis);
const patient = "delivery-patient";
const appointmentId = id("1");
const initial = {
  id: id("5"),
  appointmentId,
  revision: 0,
  recipientUserId: patient,
  channel: "email",
  dedupeKey: "one-logical-event",
  snapshot: {
    appointmentId,
    revision: 0,
    event: "confirmed",
    startsAt: "2030-01-01T00:00:00.000Z",
    endsAt: "2030-01-01T00:30:00.000Z",
    timezone: "Africa/Douala",
    consultationType: "video",
  },
  dueAt: instant(0),
  expiresAt: instant(86_400_000),
};

describe("durable notification queue (Postgres)", () => {
  let postgres: Awaited<ReturnType<typeof startTestPostgres>>;
  let db: ReturnType<typeof drizzle>;
  let runtime: ManagedRuntime.ManagedRuntime<DeliveryRepo | SqlClient.SqlClient, unknown>;
  beforeAll(async () => {
    postgres = await startTestPostgres();
    db = drizzle(postgres.url);
    const database = databaseLayerFromUrl(postgres.url);
    runtime = ManagedRuntime.make(
      Layer.mergeAll(database, DeliveryRepoLive.pipe(Layer.provide(database))),
    );
    await db.insert(user).values([
      { id: patient, name: "Patient", email: "delivery-patient@example.com", emailVerified: true },
      {
        id: "delivery-doctor",
        name: "Doctor",
        email: "delivery-doctor@example.com",
        emailVerified: true,
      },
    ]);
    await db.insert(profession).values({ id: id("2"), nameEn: "Doctor", nameFr: "Médecin" });
    await db
      .insert(practitionerProfile)
      .values({ id: id("3"), userId: "delivery-doctor", professionId: id("2") });
    await db.insert(consultationOffering).values({
      id: id("4"),
      practitionerProfileId: id("3"),
      consultationType: "video",
      durationMin: 30,
      priceXaf: 1000,
    });
    await db.insert(appointment).values({
      id: appointmentId,
      practitionerProfileId: id("3"),
      bookerUserId: patient,
      offeringId: id("4"),
      consultationType: "video",
      startsAt: new Date("2030-01-01T00:00:00Z"),
      endsAt: new Date("2030-01-01T00:30:00Z"),
      slotKey: "explicit:fixture",
      preferredLanguage: "fr",
      status: "confirmed",
    });
  });
  beforeEach(async () => {
    await db.delete(notificationDelivery);
  });
  afterAll(async () => {
    await runtime?.dispose();
    await db?.$client.end();
    await postgres?.stop();
  });
  it("rolls back appointment and notification writes together", async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* DeliveryRepo;
        const sql = yield* SqlClient.SqlClient;
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`update appointment set revision = 1 where id = ${appointmentId}`;
              yield* repo.insert([initial]);
              return yield* Effect.fail("rollback");
            }),
          )
          .pipe(Effect.ignore);
      }),
    );
    expect(await db.select().from(notificationDelivery)).toEqual([]);
    expect(
      (
        await db
          .select({ revision: appointment.revision })
          .from(appointment)
          .where(eq(appointment.id, appointmentId))
      )[0]?.revision,
    ).toBe(0);
  });
  it("deduplicates repeated lifecycle enqueueing and allows only one concurrent claim", async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* DeliveryRepo;
        yield* repo.insert([initial]);
        yield* repo.insert([{ ...initial, id: id("6") }]);
      }),
    );
    const claims = await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* DeliveryRepo;
        return yield* Effect.all(
          [
            repo.claim({ now: instant(0), limit: 1, token: id("10"), leaseUntil: instant(60_000) }),
            repo.claim({ now: instant(0), limit: 1, token: id("11"), leaseUntil: instant(60_000) }),
          ],
          { concurrency: 2 },
        );
      }),
    );
    expect(claims.map((rows) => rows.length).toSorted()).toEqual([0, 1]);
    expect(await db.select().from(notificationDelivery)).toHaveLength(1);
  });
  it("recovers an expired lease and fences a stale worker acknowledgement", async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* DeliveryRepo;
        yield* repo.insert([initial]);
        yield* repo.claim({
          now: instant(0),
          limit: 1,
          token: id("10"),
          leaseUntil: instant(60_000),
        });
        const recovered = yield* repo.claim({
          now: instant(60_001),
          limit: 1,
          token: id("11"),
          leaseUntil: instant(120_001),
        });
        expect(recovered).toHaveLength(1);
        yield* repo.finish({
          id: initial.id,
          token: id("10"),
          state: "accepted",
          now: instant(60_002),
          providerId: "stale",
        });
      }),
    );
    const rows = await db
      .select()
      .from(notificationDelivery)
      .where(eq(notificationDelivery.id, initial.id));
    expect(rows[0]?.leaseToken).toBe(id("11"));
    expect(rows[0]?.state).toBe("leased");
    expect(rows[0]?.providerId).toBeNull();
  });
  it("preserves a possibly accepted in-flight send for review when its revision is cancelled", async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* DeliveryRepo;
        yield* repo.insert([initial]);
        yield* repo.claim({
          now: instant(0),
          limit: 1,
          token: id("10"),
          leaseUntil: instant(60_000),
        });
        yield* repo.freeze({
          id: initial.id,
          token: id("10"),
          payload: {
            to: "patient@example.com",
            subject: "Reminder",
            html: "<p>Reminder</p>",
            text: "Reminder",
          },
          now: instant(1),
          leaseUntil: instant(60_001),
        });
        yield* repo.suppressPrevious(appointmentId, 1, instant(2));
        yield* repo.finish({ id: initial.id, token: id("10"), state: "accepted", now: instant(3) });
      }),
    );
    const row = (await db.select().from(notificationDelivery))[0];
    expect(row?.state).toBe("needs_review");
    expect(row?.acceptanceUnknown).toBe(true);
  });
  it("suppresses leased old reminders so their worker cannot freeze or acknowledge", async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* DeliveryRepo;
        yield* repo.insert([initial]);
        yield* repo.claim({
          now: instant(0),
          limit: 1,
          token: id("10"),
          leaseUntil: instant(60_000),
        });
        yield* repo.suppressPrevious(appointmentId, 1, instant(1));
        expect(
          yield* repo.freeze({
            id: initial.id,
            token: id("10"),
            payload: {
              to: "patient@example.com",
              subject: "Reminder",
              html: "<p>Reminder</p>",
              text: "Reminder",
            },
            now: instant(2),
            leaseUntil: instant(60_002),
          }),
        ).toBe(false);
        yield* repo.finish({ id: initial.id, token: id("10"), state: "accepted", now: instant(3) });
      }),
    );
    expect((await db.select().from(notificationDelivery))[0]?.state).toBe("suppressed");
  });
});
