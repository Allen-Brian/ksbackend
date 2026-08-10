import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { ConfigProvider, Effect, Layer, ManagedRuntime } from "effect";
import { expect } from "vitest";
import { adminProfile } from "@/db/schema/admin-profile";
import { user } from "@/db/schema/auth";
import type { AdminScope } from "@/domain/admin/admin";
import { createApp } from "@/http/app";
import { makeAuth } from "@/infra/auth";
import { type EmailClient, EmailSender, type EmailMessage } from "@/infra/email";
import { FileScanner, type ScanStatus } from "@/infra/scanner";
import { FileStorageFakeLive } from "@/infra/storage";
import { makeAppLayer } from "@/runtime";
import { databaseLayerFromUrl, startTestPostgres } from "./testcontainers";

export type TestHarness = {
  readonly app: ReturnType<typeof createApp>;
  readonly db: ReturnType<typeof drizzle>;
  readonly sent: ReadonlyArray<EmailMessage>;
  readonly post: (path: string, body: unknown, cookie?: string) => Promise<Response>;
  readonly signUpAndVerify: (email: string, password: string, name: string) => Promise<string>;
  /** Promote an existing user to admin with the given scope (role + admin_profile). */
  readonly promoteToAdmin: (email: string, scope?: AdminScope) => Promise<void>;
  readonly otpFor: (email: string) => string;
  readonly dispose: () => Promise<void>;
};

// A scan-aware fake: any file key containing "infected" reports infected, so the
// FileInfected rejection branch is drivable from tests; everything else is clean.
const scannerFake = Layer.succeed(FileScanner, {
  status: (key: string) =>
    Effect.succeed<ScanStatus>(key.includes("infected") ? "infected" : "clean"),
});

/**
 * Spins up the full app against a real (Testcontainers) Postgres, capturing all
 * email (OTP + notifications) into `sent`. `config` overrides Effect Config values
 * (e.g. RATE_LIMIT_MAX) while falling back to the environment for the rest.
 */
export const createTestHarness = async (
  config?: Record<string, string>,
  authOpts?: { readonly rateLimit?: { readonly enabled: boolean } },
): Promise<TestHarness> => {
  const pg = await startTestPostgres();
  const db = drizzle(pg.url);
  const sent: EmailMessage[] = [];
  const record = (message: EmailMessage): void => {
    sent.push(message);
  };
  const emailClient: EmailClient = { send: (message) => Promise.resolve(record(message)) };
  const capturingEmailSender = Layer.succeed(EmailSender, {
    send: (message) => Effect.sync(() => record(message)),
  });

  const baseLayer = makeAppLayer(databaseLayerFromUrl(pg.url), {
    email: capturingEmailSender,
    storage: FileStorageFakeLive,
    scanner: scannerFake,
  });
  const appLayer =
    config === undefined
      ? baseLayer
      : Layer.provide(
          baseLayer,
          Layer.setConfigProvider(
            ConfigProvider.fromMap(new Map(Object.entries(config))).pipe(
              ConfigProvider.orElse(() => ConfigProvider.fromEnv()),
            ),
          ),
        );

  const runtime = ManagedRuntime.make(appLayer);
  const auth = makeAuth({
    databaseUrl: pg.url,
    secret: "test-secret-minimum-32-characters-long",
    baseURL: "http://localhost:3000",
    defaultLocale: "en",
    emailClient,
    ...(authOpts?.rateLimit ? { rateLimit: authOpts.rateLimit } : {}),
  });
  const app = createApp(runtime, auth.instance);

  const post = async (path: string, body: unknown, cookie?: string): Promise<Response> =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });

  const otpFor = (email: string): string => {
    const message = sent.toReversed().find((m) => m.to === email && /\d{6}/.test(m.html));
    const match = message?.html.match(/(\d{6})/);
    if (match?.[1] === undefined) throw new Error(`no OTP captured for ${email}`);
    return match[1];
  };

  const signUpAndVerify = async (
    email: string,
    password: string,
    name: string,
  ): Promise<string> => {
    expect([200, 201]).toContain(
      (await post("/api/auth/sign-up/email", { email, password, name })).status,
    );
    expect(
      (await post("/api/auth/email-otp/verify-email", { email, otp: otpFor(email) })).status,
    ).toBe(200);
    const signin = await post("/api/auth/sign-in/email", { email, password });
    expect(signin.status).toBe(200);
    const cookie = signin.headers.get("set-cookie");
    if (cookie === null) throw new Error("no session cookie");
    return cookie;
  };

  const promoteToAdmin = async (
    email: string,
    scope: AdminScope = "super_admin",
  ): Promise<void> => {
    const rows = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
    const userId = rows[0]?.id;
    if (userId === undefined) throw new Error(`no user for ${email}`);
    await db.update(user).set({ role: "admin" }).where(eq(user.id, userId));
    await db.insert(adminProfile).values({ id: crypto.randomUUID(), userId, scope });
  };

  const dispose = async (): Promise<void> => {
    await runtime.dispose();
    await auth.close();
    await db.$client.end();
    await pg.stop();
  };

  return { app, db, sent, post, signUpAndVerify, promoteToAdmin, otpFor, dispose };
};
