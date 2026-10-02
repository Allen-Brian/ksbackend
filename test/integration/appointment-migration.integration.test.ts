import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { drizzle } from "drizzle-orm/node-postgres";
import { Clock, Config, Effect } from "effect";
import { z } from "zod";
import { notificationDelivery } from "@/db/schema/notification-delivery";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appointment } from "@/db/schema/appointment";
import { user } from "@/db/schema/auth";
import { consultationOffering } from "@/db/schema/consultation-offering";
import { practitionerProfile } from "@/db/schema/practitioner-profile";
import { profession } from "@/db/schema/profession";
import { startTestPostgres } from "../support/testcontainers";

const runChild = promisify(execFile);
const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const id = (suffix: string) => `019a0000-0000-7000-8000-${suffix.padStart(12, "0")}`;
const date = (value: string) => new Date(value);

describe("deployment appointment policy snapshot migration", () => {
  let postgres: Awaited<ReturnType<typeof startTestPostgres>>;
  let db: ReturnType<typeof drizzle>;
  let path: string;

  beforeAll(async () => {
    postgres = await startTestPostgres();
    db = drizzle(postgres.url);
    path = await Effect.runPromise(Config.string("PATH"));
    await db.insert(user).values([
      { id: "migration-patient", name: "Patient", email: "migration-patient@example.com" },
      { id: "migration-doctor", name: "Doctor", email: "migration-doctor@example.com" },
    ]);
    await db.insert(profession).values({ id: id("1"), nameEn: "Doctor", nameFr: "Médecin" });
    await db.insert(practitionerProfile).values({
      id: id("2"),
      userId: "migration-doctor",
      professionId: id("1"),
    });
    await db.insert(consultationOffering).values({
      id: id("3"),
      practitionerProfileId: id("2"),
      consultationType: "video",
      durationMin: 30,
      priceXaf: 1000,
    });
    const now = await Effect.runPromise(Clock.currentTimeMillis);
    await db.insert(appointment).values([
      {
        id: id("10"),
        practitionerProfileId: id("2"),
        bookerUserId: "migration-patient",
        offeringId: id("3"),
        consultationType: "video",
        startsAt: new Date(now + 72 * 3_600_000),
        endsAt: new Date(now + 72 * 3_600_000 + 30 * 60_000),
        slotKey: "rule:legacy-booking",
        preferredLanguage: "fr",
        status: "confirmed",
        revision: 7,
        cancellationCutoffHours: null,
        updatedAt: date("2026-01-01T00:00:00Z"),
      },
      {
        id: id("20"),
        practitionerProfileId: id("2"),
        bookerUserId: "migration-patient",
        offeringId: id("3"),
        consultationType: "video",
        startsAt: new Date(now + 96 * 3_600_000),
        endsAt: new Date(now + 96 * 3_600_000 + 30 * 60_000),
        slotKey: "rule:snapshotted-booking",
        preferredLanguage: "fr",
        status: "cancelled",
        revision: 3,
        cancellationCutoffHours: 12,
        updatedAt: date("2026-01-02T00:00:00Z"),
      },
    ]);
  });

  afterAll(async () => {
    await db?.$client.end();
    await postgres?.stop();
  });

  const deploy = (cutoff: number) =>
    runChild("bun", ["src/migrate.ts"], {
      cwd: projectRoot,
      env: {
        PATH: path,
        DATABASE_URL: postgres.url,
        APPOINTMENT_CANCEL_CUTOFF_HOURS: String(cutoff),
      },
      timeout: 30_000,
    });

  const read = () =>
    db
      .select({
        id: appointment.id,
        cutoff: appointment.cancellationCutoffHours,
        revision: appointment.revision,
        status: appointment.status,
        updatedAt: appointment.updatedAt,
      })
      .from(appointment)
      .orderBy(appointment.id);

  it("freezes legacy policy once and preserves existing snapshots and booking lifecycle", async () => {
    await deploy(24);
    const expected = [
      {
        id: id("10"),
        cutoff: 24,
        revision: 7,
        status: "confirmed",
        updatedAt: date("2026-01-01T00:00:00Z"),
      },
      {
        id: id("20"),
        cutoff: 12,
        revision: 3,
        status: "cancelled",
        updatedAt: date("2026-01-02T00:00:00Z"),
      },
    ];
    expect(await read()).toEqual(expected);

    // Redeploying with a different global policy must not rewrite promises made
    // to patients before that deployment, or create a new booking transition.
    await deploy(48);
    expect(await read()).toEqual(expected);
  });
  it("runs the packaged backfill without provider credentials and never queues receipts or duplicates", async () => {
    const invoke = () =>
      runChild("bun", ["scripts/backfill-delivery.ts"], {
        cwd: projectRoot,
        env: { PATH: path, DATABASE_URL: postgres.url },
        timeout: 30_000,
      });
    const first = await invoke();
    expect(
      z
        .object({ count: z.number(), nextCursor: z.string().optional() })
        .parse(JSON.parse(first.stdout)),
    ).toEqual({ count: 1 });
    const rows = await db.select().from(notificationDelivery);
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(z.object({ event: z.string() }).parse(row.snapshot).event).toBe("reminder");
      expect(row.state).toBe("pending");
      expect(row.attempts).toBe(0);
      expect(row.providerId).toBeNull();
      expect(row.frozenPayload).toBeNull();
    }
    await invoke();
    expect(await db.select().from(notificationDelivery)).toHaveLength(4);
  });
});
