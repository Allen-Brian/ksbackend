#!/usr/bin/env bun
/**
 * Idempotent seed: the initial professions, the first admin account, and the demo
 * accounts + data behind the committed Bruno collection (see bruno/ and
 * docs/local-dev.md → "Demoing the API with Bruno").
 * Run via `bun run db:seed` (wraps `varlock run`). Reads env directly (edge script).
 */
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { v7 as uuidv7 } from "uuid";
import { adminProfile } from "../src/db/schema/admin-profile";
import { user } from "../src/db/schema/auth";
import { profession } from "../src/db/schema/profession";
import { language } from "../src/db/schema/language";
import { patientProfile } from "../src/db/schema/patient-profile";
import { practitionerProfile } from "../src/db/schema/practitioner-profile";
import { practitionerQualification } from "../src/db/schema/practitioner-qualification";
import { practiceLocation } from "../src/db/schema/practice-location";
import { consultationOffering } from "../src/db/schema/consultation-offering";
import { availabilityRule } from "../src/db/schema/availability-rule";
import { profile } from "../src/db/schema/profile";
import { review } from "../src/db/schema/review";
import { makeAuth, type Role } from "../src/infra/auth";
import { makeConsoleClient } from "../src/infra/email";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://kanasante:kanasante@localhost:5432/kanasante";

const db = drizzle(databaseUrl);

// One auth instance for every seeded account (admin + demo users); closed at the end.
const auth = makeAuth({
  databaseUrl,
  secret: process.env.BETTER_AUTH_SECRET ?? "dev-only-insecure-secret-change-in-production-000",
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
  defaultLocale: "fr",
  emailClient: makeConsoleClient(),
});

// Fixed instant so re-runs write identical rows (edge script — the src-only Clock rule doesn't apply).
const seedInstant = new Date("2026-01-01T00:00:00Z");

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

const languages = [
  { id: "0198e3f0-0000-7000-8000-000000000001", code: "en", nameEn: "English", nameFr: "Anglais" },
  { id: "0198e3f0-0000-7000-8000-000000000002", code: "fr", nameEn: "French", nameFr: "Français" },
  { id: "0198e3f0-0000-7000-8000-000000000003", code: "de", nameEn: "German", nameFr: "Allemand" },
  { id: "0198e3f0-0000-7000-8000-000000000004", code: "es", nameEn: "Spanish", nameFr: "Espagnol" },
  { id: "0198e3f0-0000-7000-8000-000000000005", code: "ar", nameEn: "Arabic", nameFr: "Arabe" },
  {
    id: "0198e3f0-0000-7000-8000-000000000006",
    code: "pt",
    nameEn: "Portuguese",
    nameFr: "Portugais",
  },
  { id: "0198e3f0-0000-7000-8000-000000000007", code: "sw", nameEn: "Swahili", nameFr: "Swahili" },
];

const seedProfessions = async (): Promise<void> => {
  await Promise.all(
    professions.map((row) =>
      db.insert(profession).values(row).onConflictDoNothing({ target: profession.id }),
    ),
  );
  console.log(`✓ seeded ${professions.length} professions`);
};

const seedLanguages = async (): Promise<void> => {
  await Promise.all(
    languages.map((row) =>
      db.insert(language).values(row).onConflictDoNothing({ target: language.code }),
    ),
  );
  console.log(`✓ seeded ${languages.length} languages`);
};

const findUserId = async (email: string): Promise<string | undefined> => {
  const rows = await db.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);
  return rows[0]?.id;
};

/** A real better-auth account (can sign in), pre-verified so no OTP round-trip is needed. */
const ensureAccountUser = async (values: {
  readonly email: string;
  readonly password: string;
  readonly name: string;
  readonly role: string;
}): Promise<string> => {
  const existing = await findUserId(values.email);
  if (existing !== undefined) return existing;
  await auth.instance.api.signUpEmail({
    body: { email: values.email, password: values.password, name: values.name },
  });
  await db
    .update(user)
    .set({ role: values.role, emailVerified: true })
    .where(eq(user.email, values.email));
  const id = await findUserId(values.email);
  if (id === undefined) throw new Error(`sign-up for ${values.email} left no user row`);
  return id;
};

/** A bare user row (no credentials — never signs in); enough to own a practitioner profile. */
const ensureRowUser = async (values: {
  readonly email: string;
  readonly name: string;
  readonly role: string;
}): Promise<string> => {
  await db
    .insert(user)
    .values({
      id: uuidv7(),
      name: values.name,
      email: values.email,
      emailVerified: true,
      role: values.role,
      locale: "fr",
      createdAt: seedInstant,
      updatedAt: seedInstant,
    })
    .onConflictDoNothing({ target: user.email });
  const id = await findUserId(values.email);
  if (id === undefined) throw new Error(`insert for ${values.email} left no user row`);
  return id;
};

const ensureProfile = async (
  userId: string,
  values: { readonly surname: string; readonly givenNames: string; readonly phone?: string },
): Promise<void> => {
  await db
    .insert(profile)
    .values({
      id: uuidv7(),
      userId,
      surname: values.surname,
      givenNames: values.givenNames,
      phone: values.phone,
      consentAcceptedAt: seedInstant,
      consentVersion: "v1",
      createdAt: seedInstant,
      updatedAt: seedInstant,
    })
    .onConflictDoNothing({ target: profile.userId });
};

const ensurePatientProfile = async (
  userId: string,
  emergencyContact = { name: "Emmanuel Tchamba", phone: "+237655000000", relationship: "spouse" },
): Promise<void> => {
  await db
    .insert(patientProfile)
    .values({
      id: uuidv7(),
      userId,
      emergencyContactName: emergencyContact.name,
      emergencyContactPhone: emergencyContact.phone,
      emergencyContactRelationship: emergencyContact.relationship,
      createdAt: seedInstant,
      updatedAt: seedInstant,
    })
    .onConflictDoNothing({ target: patientProfile.userId });
};

type DemoDoctor = {
  readonly email: string;
  /** Present only for the sign-in demo doctor (comes from DEMO_DOCTOR_* env). */
  readonly password?: string;
  readonly role: Role;
  readonly surname: string;
  readonly givenNames: string;
  readonly professionId: string;
  readonly prefix: string | null;
  readonly specialty: string;
  readonly bio: string;
  readonly location: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly feeXaf: number;
  readonly yearsExperience: number;
  readonly languagesSpoken: ReadonlyArray<string>;
  /** Public registration number — the public detail view 404s without one. */
  readonly cmcNumber: string;
  readonly verificationStatus: "verified" | "pending_verification";
  /** A review left by the demo patient, so rating cards look real. */
  readonly review?: { readonly rating: number; readonly comment: string };
};

const ensurePractitionerProfile = async (userId: string, doc: DemoDoctor): Promise<string> => {
  await db
    .insert(practitionerProfile)
    .values({
      id: uuidv7(),
      userId,
      professionId: doc.professionId,
      prefix: doc.prefix,
      location: doc.location,
      specialty: doc.specialty,
      bio: doc.bio,
      languagesSpoken: [...doc.languagesSpoken],
      yearsExperience: doc.yearsExperience,
      consultationFeeXaf: doc.feeXaf,
      consultationTypes: ["in_person"],
      latitude: doc.latitude,
      longitude: doc.longitude,
      cmcNumber: doc.cmcNumber,
      verificationStatus: doc.verificationStatus,
      verificationSubmittedAt:
        doc.verificationStatus === "pending_verification" ? seedInstant : null,
      createdAt: seedInstant,
      updatedAt: seedInstant,
    })
    .onConflictDoNothing({ target: practitionerProfile.userId });
  // Backfill for rows seeded before cmcNumber was part of the demo data.
  await db
    .update(practitionerProfile)
    .set({ cmcNumber: doc.cmcNumber })
    .where(and(eq(practitionerProfile.userId, userId), isNull(practitionerProfile.cmcNumber)));
  const rows = await db
    .select({ id: practitionerProfile.id })
    .from(practitionerProfile)
    .where(eq(practitionerProfile.userId, userId))
    .limit(1);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error(`no practitioner profile row for ${doc.email}`);
  return id;
};

const ensureReview = async (
  practitionerProfileId: string,
  reviewerUserId: string,
  values: { readonly rating: number; readonly comment: string },
): Promise<void> => {
  await db
    .insert(review)
    .values({
      id: uuidv7(),
      practitionerProfileId,
      reviewerUserId,
      rating: values.rating,
      comment: values.comment,
      createdAt: seedInstant,
      updatedAt: seedInstant,
    })
    .onConflictDoNothing();
  // Recompute the denormalized aggregate from the active rows (same rule as the service).
  const rows = await db
    .select({ rating: review.rating })
    .from(review)
    .where(and(eq(review.practitionerProfileId, practitionerProfileId), isNull(review.deletedAt)));
  const count = rows.length;
  const average =
    count === 0 ? 0 : Math.round((rows.reduce((sum, r) => sum + r.rating, 0) / count) * 100) / 100;
  await db
    .update(practitionerProfile)
    .set({ ratingAverage: average, ratingCount: count })
    .where(eq(practitionerProfile.id, practitionerProfileId));
};

/**
 * Enrich an existing practitioner (by email) with the rows a complete demo profile
 * needs: a practice location, a qualification, an offering, and Mon–Fri availability.
 */
const enrichPractitionerDetail = async (email: string): Promise<void> => {
  const rows = await db
    .select({ profile: practitionerProfile })
    .from(practitionerProfile)
    .innerJoin(user, eq(user.id, practitionerProfile.userId))
    .where(eq(user.email, email))
    .limit(1);
  const found = rows[0]?.profile;
  if (found === undefined) {
    console.log(`• no practitioner profile for ${email} — skipping practitioner detail seed`);
    return;
  }

  const locations = await db
    .select({ id: practiceLocation.id })
    .from(practiceLocation)
    .where(
      and(eq(practiceLocation.practitionerProfileId, found.id), isNull(practiceLocation.deletedAt)),
    )
    .limit(1);
  const locationId = locations[0]?.id ?? uuidv7();
  if (locations.length === 0) {
    await db.insert(practiceLocation).values({
      id: locationId,
      practitionerProfileId: found.id,
      label: "Primary practice",
      addressLine1: found.location ?? "Douala",
      city: found.location ?? "Douala",
      region: "Littoral",
      consultationTypes: ["in_person"],
      isPrimary: true,
      latitude: found.latitude,
      longitude: found.longitude,
    });
  }
  const qualifications = await db
    .select({ id: practitionerQualification.id })
    .from(practitionerQualification)
    .where(
      and(
        eq(practitionerQualification.practitionerProfileId, found.id),
        isNull(practitionerQualification.deletedAt),
      ),
    )
    .limit(1);
  if (qualifications.length === 0) {
    await db.insert(practitionerQualification).values({
      id: uuidv7(),
      practitionerProfileId: found.id,
      kind: "degree",
      title: "Doctor of Medicine",
      institution: "Faculty of Medicine and Biomedical Sciences",
      country: "CM",
      year: 2015,
    });
  }
  await db
    .insert(consultationOffering)
    .values({
      id: uuidv7(),
      practitionerProfileId: found.id,
      consultationType: "in_person",
      durationMin: 30,
      priceXaf: found.consultationFeeXaf ?? 10_000,
    })
    .onConflictDoNothing();
  const rules = await db
    .select({ id: availabilityRule.id })
    .from(availabilityRule)
    .where(eq(availabilityRule.practitionerProfileId, found.id))
    .limit(1);
  if (rules.length === 0) {
    const consultationTypes: Array<"in_person"> = ["in_person"];
    await db.insert(availabilityRule).values(
      [1, 2, 3, 4, 5].map((weekday) => ({
        id: uuidv7(),
        practitionerProfileId: found.id,
        weekday,
        startTime: "09:00",
        endTime: "17:00",
        slotDurationMin: 30,
        consultationTypes: [...consultationTypes],
        locationId,
      })),
    );
  }
  console.log(`✓ seeded practitioner detail data for ${email}`);
};

const seedDemoPractitionerDetail = async (): Promise<void> => {
  const email = process.env.DEMO_PRACTITIONER_EMAIL;
  if (!email) {
    console.log("• DEMO_PRACTITIONER_EMAIL not set — skipping practitioner detail seed");
    return;
  }
  await enrichPractitionerDetail(email);
};

const seedAdmin = async (): Promise<void> => {
  const email = process.env.ADMIN_SEED_EMAIL;
  const password = process.env.ADMIN_SEED_PASSWORD;
  if (!email || !password) {
    console.log("• ADMIN_SEED_EMAIL / ADMIN_SEED_PASSWORD not set — skipping admin seed");
    return;
  }

  const existing = await findUserId(email);
  if (existing !== undefined) {
    console.log(`• admin ${email} already exists — skipping`);
    return;
  }

  const adminId = await ensureAccountUser({
    email,
    password,
    name: "KanaSanté Admin",
    role: "admin",
  });
  await db
    .insert(adminProfile)
    .values({ id: uuidv7(), userId: adminId, scope: "super_admin" })
    .onConflictDoNothing({ target: adminProfile.userId });
  console.log(`✓ seeded admin ${email}`);
};

// Douala ≈ (4.05, 9.70); Yaoundé ≈ (3.87, 11.52); Bafoussam ≈ (5.48, 10.42).
const supportingDoctors = (patientReviews: boolean): ReadonlyArray<DemoDoctor> => [
  {
    email: "amara.nkeng@demo.kanasante.local",
    role: "doctor",
    surname: "Nkeng",
    givenNames: "Amara",
    professionId: "00000000-0000-4000-8000-000000000002",
    prefix: "Dr.",
    specialty: "Cardiology",
    bio: "Consultant cardiologist focused on hypertension and preventive heart care.",
    location: "Douala",
    latitude: 4.05,
    longitude: 9.7,
    feeXaf: 15_000,
    yearsExperience: 12,
    languagesSpoken: ["fr", "en"],
    cmcNumber: "CMC-LT-2013-0412",
    verificationStatus: "verified",
    review: patientReviews
      ? { rating: 5, comment: "Très à l'écoute — a pris le temps d'expliquer chaque examen." }
      : undefined,
  },
  {
    email: "etienne.mbarga@demo.kanasante.local",
    role: "doctor",
    surname: "Mbarga",
    givenNames: "Étienne",
    professionId: "00000000-0000-4000-8000-000000000002",
    prefix: "Dr.",
    specialty: "Pediatrics",
    bio: "Paediatrician with a special interest in vaccination and early childhood nutrition.",
    location: "Yaoundé",
    latitude: 3.87,
    longitude: 11.52,
    feeXaf: 10_000,
    yearsExperience: 8,
    languagesSpoken: ["fr"],
    cmcNumber: "CMC-CE-2017-0893",
    verificationStatus: "verified",
    review: patientReviews
      ? { rating: 4, comment: "Great with kids; the wait was a little long but worth it." }
      : undefined,
  },
  {
    email: "solange.fokam@demo.kanasante.local",
    role: "doctor",
    surname: "Fokam",
    givenNames: "Solange",
    professionId: "00000000-0000-4000-8000-000000000002",
    prefix: "Dr.",
    specialty: "Dermatology",
    bio: "Dermatologist treating chronic skin conditions with tele-consultation follow-ups.",
    location: "Douala",
    latitude: 4.06,
    longitude: 9.71,
    feeXaf: 12_000,
    yearsExperience: 10,
    languagesSpoken: ["fr", "en"],
    cmcNumber: "CMC-LT-2015-0627",
    verificationStatus: "verified",
    review: patientReviews
      ? { rating: 5, comment: "Diagnosed in one visit what others missed for months." }
      : undefined,
  },
  {
    email: "beatrice.tchoua@demo.kanasante.local",
    role: "nurse",
    surname: "Tchoua",
    givenNames: "Béatrice",
    professionId: "00000000-0000-4000-8000-000000000003",
    prefix: null,
    specialty: "Home care",
    bio: "Registered nurse providing home visits: wound care, injections, and elderly support.",
    location: "Bafoussam",
    latitude: 5.48,
    longitude: 10.42,
    feeXaf: 6_000,
    yearsExperience: 14,
    languagesSpoken: ["fr"],
    cmcNumber: "ONIC-OU-2011-0288",
    verificationStatus: "verified",
  },
  {
    email: "paul.etoga@demo.kanasante.local",
    role: "doctor",
    surname: "Etoga",
    givenNames: "Paul",
    professionId: "00000000-0000-4000-8000-000000000001",
    prefix: "Dr.",
    specialty: "General Medicine",
    bio: "General practitioner awaiting credential verification.",
    location: "Yaoundé",
    latitude: 3.88,
    longitude: 11.5,
    feeXaf: 8_000,
    yearsExperience: 5,
    languagesSpoken: ["fr", "en"],
    cmcNumber: "CMC-CE-2020-1104",
    // Keeps the admin verification queue non-empty for the demo.
    verificationStatus: "pending_verification",
  },
];

/**
 * The accounts the Bruno collection signs in with (bruno/environments/local.bru must
 * use the same credentials), plus a supporting cast of practitioners so search
 * results, ratings, and the admin queue all have something to show.
 */
const seedDemoUsers = async (): Promise<void> => {
  const patientEmail = process.env.DEMO_PATIENT_EMAIL;
  const patientPassword = process.env.DEMO_PATIENT_PASSWORD;
  const doctorEmail = process.env.DEMO_DOCTOR_EMAIL;
  const doctorPassword = process.env.DEMO_DOCTOR_PASSWORD;
  const adminEmail = process.env.DEMO_ADMIN_EMAIL;
  const adminPassword = process.env.DEMO_ADMIN_PASSWORD;
  if (
    !patientEmail ||
    !patientPassword ||
    !doctorEmail ||
    !doctorPassword ||
    !adminEmail ||
    !adminPassword
  ) {
    console.log(
      "• DEMO_PATIENT_* / DEMO_DOCTOR_* / DEMO_ADMIN_* not set — skipping demo user seed",
    );
    return;
  }

  const demoAdminId = await ensureAccountUser({
    email: adminEmail,
    password: adminPassword,
    name: "Demo Admin",
    role: "admin",
  });
  await db
    .insert(adminProfile)
    .values({ id: uuidv7(), userId: demoAdminId, scope: "super_admin" })
    .onConflictDoNothing({ target: adminProfile.userId });
  console.log(`✓ seeded demo admin ${adminEmail}`);

  const patientId = await ensureAccountUser({
    email: patientEmail,
    password: patientPassword,
    name: "Claire Tchamba",
    role: "patient",
  });
  await ensureProfile(patientId, {
    surname: "Tchamba",
    givenNames: "Claire",
    phone: "+237655000001",
  });
  await ensurePatientProfile(patientId);
  console.log(`✓ seeded demo patient ${patientEmail}`);

  // A second patient lets the booking demo show two people contending for one slot.
  const patient2Email = process.env.DEMO_PATIENT_2_EMAIL;
  const patient2Password = process.env.DEMO_PATIENT_2_PASSWORD;
  if (patient2Email && patient2Password) {
    const patient2Id = await ensureAccountUser({
      email: patient2Email,
      password: patient2Password,
      name: "Bernard Fon",
      role: "patient",
    });
    await ensureProfile(patient2Id, {
      surname: "Fon",
      givenNames: "Bernard",
      phone: "+237655000002",
    });
    await ensurePatientProfile(patient2Id, {
      name: "Solange Fon",
      phone: "+237655000003",
      relationship: "sister",
    });
    console.log(`✓ seeded second demo patient ${patient2Email}`);
  } else {
    console.log("• DEMO_PATIENT_2_* not set — skipping the second demo patient");
  }

  const signInDoctor: DemoDoctor = {
    email: doctorEmail,
    password: doctorPassword,
    role: "doctor",
    surname: "Ngassa",
    givenNames: "Marie",
    professionId: "00000000-0000-4000-8000-000000000001",
    prefix: "Dr.",
    specialty: "General Medicine",
    bio: "Family doctor in Douala; general consultations, chronic-condition follow-up, referrals.",
    location: "Douala",
    latitude: 4.04,
    longitude: 9.69,
    feeXaf: 9_000,
    yearsExperience: 9,
    languagesSpoken: ["fr", "en"],
    cmcNumber: "CMC-LT-2016-0741",
    verificationStatus: "verified",
    review: { rating: 5, comment: "Booked from Paris for my mother in Douala — seamless." },
  };

  for (const doc of [signInDoctor, ...supportingDoctors(true)]) {
    const name = `${doc.prefix === null ? "" : `${doc.prefix} `}${doc.givenNames} ${doc.surname}`;
    const userId =
      doc.password === undefined
        ? await ensureRowUser({ email: doc.email, name, role: doc.role })
        : await ensureAccountUser({
            email: doc.email,
            password: doc.password,
            name,
            role: doc.role,
          });
    await ensureProfile(userId, { surname: doc.surname, givenNames: doc.givenNames });
    const profileId = await ensurePractitionerProfile(userId, doc);
    if (doc.verificationStatus === "verified") {
      await enrichPractitionerDetail(doc.email);
    }
    if (doc.review !== undefined) {
      await ensureReview(profileId, patientId, doc.review);
    }
  }
  console.log(
    `✓ seeded demo doctor ${doctorEmail} + ${supportingDoctors(false).length} supporting practitioners`,
  );
};

await seedProfessions();
await seedLanguages();
await seedAdmin();
await seedDemoUsers();
await seedDemoPractitionerDetail();
await auth.close();
await db.$client.end();
console.log("Seed complete.");
