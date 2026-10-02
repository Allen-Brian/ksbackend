import * as Reactivity from "@effect/experimental/Reactivity";
import * as SqlClient from "@effect/sql/SqlClient";
import * as Statement from "@effect/sql/Statement";
import { it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, TestClock } from "effect";
import { expect } from "vitest";
import {
  DeliveryTransport,
  DeliveryTransportError,
  type DeliveryMessage,
} from "@/infra/delivery-transport";
import { IdGenerator } from "@/infra/ids";
import { DeliveryRepo, type DeliveryRow } from "./delivery.repo";
import { DeliveryService, DeliveryServiceLive } from "./delivery.service";

const instant = (millis: number) => new Date(millis);
const appointmentId = "019a0000-0000-7000-8000-000000000001";
const recipient = "patient";
const harness = (
  options: {
    revision?: number;
    email?: string;
    frozenEmail?: string;
    transient?: boolean;
    expired?: boolean;
    unknown?: boolean;
  } = {},
) => {
  let row: DeliveryRow = {
    id: "019a0000-0000-7000-8000-000000000002",
    appointmentId,
    revision: 1,
    recipientUserId: recipient,
    channel: "email",
    dedupeKey: "unique-confirmation",
    snapshot: {
      appointmentId,
      revision: 1,
      event: "confirmed",
      startsAt: "1970-01-03T00:00:00.000Z",
      endsAt: "1970-01-03T00:30:00.000Z",
      timezone: "Africa/Douala",
      consultationType: "video",
    },
    frozenPayload:
      options.frozenEmail === undefined
        ? null
        : {
            to: options.frozenEmail,
            subject: "Appointment confirmed",
            html: "<p>Frozen message</p>",
            text: "Frozen message",
          },
    dueAt: instant(0),
    expiresAt: instant(options.expired ? -1 : 23 * 3_600_000),
    state: "pending",
    attempts: 0,
    firstAttemptAt: null,
    leaseToken: null,
    leaseUntil: null,
    providerId: null,
    lastError: null,
    acceptanceUnknown: options.unknown ?? false,
    createdAt: instant(0),
    updatedAt: instant(0),
  };
  const mailbox: DeliveryMessage[] = [];
  let outage = options.transient ?? false;
  const repo = Layer.succeed(DeliveryRepo, {
    insert: () => Effect.void,
    suppressPrevious: () => Effect.void,
    practitionerUserId: () => Effect.succeed("doctor"),
    contact: () =>
      Effect.succeed({
        email: options.email ?? "patient@example.com",
        emailVerified: true,
        locale: "fr",
        phone: null,
        emailEnabled: true,
        pushEnabled: false,
      }),
    current: () =>
      Effect.succeed({
        id: appointmentId,
        revision: options.revision ?? 1,
        status: "confirmed",
        startsAt: instant(2 * 86_400_000),
        endsAt: instant(2 * 86_400_000 + 30 * 60_000),
        consultationType: "video",
        scheduleTimezone: "Africa/Douala",
        bookerUserId: recipient,
        subjectUserId: null,
        dependentId: null,
        practitionerProfileId: "doctor-profile",
      }),
    caregiverActive: () => Effect.succeed(true),
    claim: ({ now, token, leaseUntil }) =>
      Effect.sync(() => {
        if (row.state !== "pending" || row.dueAt > now) return [];
        row = {
          ...row,
          state: "leased",
          leaseToken: token,
          leaseUntil,
          firstAttemptAt: row.firstAttemptAt ?? now,
          attempts: row.attempts + 1,
        };
        return [row];
      }),
    freeze: ({ token, payload }) =>
      Effect.sync(() => {
        if (row.leaseToken !== token) return false;
        row = { ...row, frozenPayload: payload };
        return true;
      }),
    finish: ({ token, state, dueAt, providerId, error, acceptanceUnknown }) =>
      Effect.sync(() => {
        if (row.leaseToken !== token) return;
        row = {
          ...row,
          state,
          dueAt: dueAt ?? row.dueAt,
          providerId: providerId ?? row.providerId,
          lastError: error ?? row.lastError,
          acceptanceUnknown: acceptanceUnknown ?? row.acceptanceUnknown,
          leaseToken: null,
          leaseUntil: null,
        };
      }),
    futureConfirmed: () => Effect.succeed([]),
  });
  const transport = Layer.succeed(DeliveryTransport, {
    listPushSubscriptions: () => Effect.succeed([]),
    send: (message) =>
      Effect.suspend(() => {
        if (outage) {
          outage = false;
          return Effect.fail(
            new DeliveryTransportError({
              reason: "Temporary outage",
              retryable: true,
              ambiguous: false,
            }),
          );
        }
        mailbox.push(message);
        return Effect.succeed({ providerId: "provider-1" });
      }),
  });
  const unusedSql = Layer.effect(
    SqlClient.SqlClient,
    SqlClient.make({
      acquirer: Effect.die("Unit worker should not access SQL directly"),
      compiler: Statement.makeCompilerSqlite(),
      spanAttributes: [],
    }),
  ).pipe(Layer.provide(Reactivity.layer));
  const layer = DeliveryServiceLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        unusedSql,
        repo,
        transport,
        Layer.succeed(IdGenerator, {
          next: Effect.succeed("019a0000-0000-7000-8000-000000000003"),
        }),
      ),
    ),
  );
  return { layer, row: () => row, mailbox };
};

it.effect("suppresses a confirmation superseded by a newer appointment revision", () => {
  const fake = harness({ revision: 2 });
  return Effect.gen(function* () {
    const service = yield* DeliveryService;
    yield* service.runPass();
    expect(fake.row().state).toBe("suppressed");
    expect(fake.mailbox).toHaveLength(0);
  }).pipe(Effect.provide(fake.layer), Effect.withConfigProvider(ConfigProvider.fromMap(new Map())));
});
it.effect("retries a provider outage after backoff and records its acceptance", () => {
  const fake = harness({ transient: true });
  return Effect.gen(function* () {
    const service = yield* DeliveryService;
    yield* service.runPass();
    expect(fake.row().state).toBe("pending");
    yield* service.runPass();
    expect(fake.mailbox).toHaveLength(0);
    yield* TestClock.adjust("60 seconds");
    yield* service.runPass();
    expect(fake.row().state).toBe("accepted");
    expect(fake.row().providerId).toBe("provider-1");
    expect(fake.mailbox[0]?.subject).toBe("Rendez-vous confirmé");
    expect(fake.mailbox[0]?.dedupeKey).toBe("unique-confirmation");
  }).pipe(Effect.provide(fake.layer), Effect.withConfigProvider(ConfigProvider.fromMap(new Map())));
});
it.effect("does not resend frozen appointment details to an obsolete email address", () => {
  const fake = harness({ frozenEmail: "old@example.com", email: "new@example.com" });
  return Effect.gen(function* () {
    const service = yield* DeliveryService;
    yield* service.runPass();
    expect(fake.row().state).toBe("suppressed");
    expect(fake.mailbox).toHaveLength(0);
  }).pipe(Effect.provide(fake.layer), Effect.withConfigProvider(ConfigProvider.fromMap(new Map())));
});
it.effect("retains ambiguous expired attempts for operator review", () => {
  const fake = harness({ expired: true, unknown: true });
  return Effect.gen(function* () {
    const service = yield* DeliveryService;
    yield* service.runPass();
    expect(fake.row().state).toBe("needs_review");
    expect(fake.mailbox).toHaveLength(0);
  }).pipe(Effect.provide(fake.layer), Effect.withConfigProvider(ConfigProvider.fromMap(new Map())));
});
