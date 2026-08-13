#!/usr/bin/env bun
/**
 * Idempotent seed: the initial professions and the first admin account.
 * Run via `bun run db:seed` (wraps `varlock run`). Reads env directly (edge script).
 */
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { adminProfile } from "../src/db/schema/admin-profile";
import { user } from "../src/db/schema/auth";
import { profession } from "../src/db/schema/profession";
import { makeAuth } from "../src/infra/auth";
import { makeConsoleClient } from "../src/infra/email";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://kanasante:kanasante@localhost:5432/kanasante";

const db = drizzle(databaseUrl);

const professions = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    nameEn: "Doctor (General Practitioner)",
    nameFr: "Médecin (généraliste)",
    prefixHint: "Dr.",
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    nameEn: "Specialist Physician",
    nameFr: "Médecin spécialiste",
    prefixHint: "Dr.",
  },
  {
    id: "00000000-0000-4000-8000-000000000003",
    nameEn: "Nurse",
    nameFr: "Infirmier / Infirmière",
    prefixHint: null,
  },
  {
    id: "00000000-0000-4000-8000-000000000004",
    nameEn: "Midwife",
    nameFr: "Sage-femme",
    prefixHint: null,
  },
];

const seedProfessions = async (): Promise<void> => {
  await Promise.all(
    professions.map((row) =>
      db.insert(profession).values(row).onConflictDoNothing({ target: profession.id }),
    ),
  );
  console.log(`✓ seeded ${professions.length} professions`);
};

const seedAdmin = async (): Promise<void> => {
  const email = process.env.ADMIN_SEED_EMAIL;
  const password = process.env.ADMIN_SEED_PASSWORD;
  if (!email || !password) {
    console.log("• ADMIN_SEED_EMAIL / ADMIN_SEED_PASSWORD not set — skipping admin seed");
    return;
  }

  const existing = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);
  if (existing.length > 0) {
    console.log(`• admin ${email} already exists — skipping`);
    return;
  }

  const auth = makeAuth({
    databaseUrl,
    secret: process.env.BETTER_AUTH_SECRET ?? "dev-only-insecure-secret-change-in-production-000",
    baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
    defaultLocale: "fr",
    emailClient: makeConsoleClient(),
  });
  await auth.instance.api.signUpEmail({ body: { email, password, name: "KanaSanté Admin" } });
  await db.update(user).set({ role: "admin", emailVerified: true }).where(eq(user.email, email));
  const admin = await db.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);
  const adminId = admin[0]?.id;
  if (adminId !== undefined) {
    await db
      .insert(adminProfile)
      .values({ id: crypto.randomUUID(), userId: adminId, scope: "super_admin" })
      .onConflictDoNothing({ target: adminProfile.userId });
  }
  await auth.close();
  console.log(`✓ seeded admin ${email}`);
};

await seedProfessions();
await seedAdmin();
await db.$client.end();
console.log("Seed complete.");
