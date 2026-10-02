import { SqlClient, SqlError } from "@effect/sql";
import { Clock, Config, Context, Effect, Layer, Schedule } from "effect";
import {
  type DeliverySnapshot,
  type FrozenDelivery,
  reminderDeadlines,
  retryDelayMillis,
} from "@/domain/delivery/delivery";
import { DeliveryTransport, DeliveryTransportError } from "@/infra/delivery-transport";
import { renderEmail } from "@/infra/email-render";
import { IdGenerator } from "@/infra/ids";
import {
  DeliverySnapshot as DeliverySnapshotDecoder,
  FrozenDelivery as FrozenDeliveryDecoder,
} from "./delivery.contract";
import { DeliveryRepo, type DeliveryRow, type CurrentAppointment } from "./delivery.repo";

export type DeliveryEnqueueInput = {
  readonly appointmentId: string;
  readonly revision: number;
  readonly kind: "confirmed" | "cancelled" | "rescheduled";
  readonly previousStartsAt?: Date | undefined;
};
export class DeliveryService extends Context.Tag("DeliveryService")<
  DeliveryService,
  {
    readonly enqueue: (input: DeliveryEnqueueInput) => Effect.Effect<void, SqlError.SqlError>;
    readonly runPass: () => Effect.Effect<number, SqlError.SqlError>;
    readonly run: () => Effect.Effect<never, SqlError.SqlError>;
    readonly backfill: (input?: {
      readonly limit?: number;
      readonly cursor?: string;
    }) => Effect.Effect<
      { readonly count: number; readonly nextCursor: string | undefined },
      SqlError.SqlError
    >;
  }
>() {}

export const DeliveryServiceLive = Layer.effect(
  DeliveryService,
  Effect.gen(function* () {
    const repo = yield* DeliveryRepo;
    const sql = yield* SqlClient.SqlClient;
    const transport = yield* DeliveryTransport;
    const ids = yield* IdGenerator;
    const batchSize = yield* Config.integer("DELIVERY_BATCH_SIZE").pipe(
      Config.withDefault(20),
      Config.validate({
        message: "DELIVERY_BATCH_SIZE must be 1..100",
        validation: (n) => n >= 1 && n <= 100,
      }),
    );
    const concurrency = yield* Config.integer("DELIVERY_CONCURRENCY").pipe(
      Config.withDefault(4),
      Config.validate({
        message: "DELIVERY_CONCURRENCY must be 1..20",
        validation: (n) => n >= 1 && n <= 20,
      }),
    );
    const leaseSeconds = yield* Config.integer("DELIVERY_LEASE_SECONDS").pipe(
      Config.withDefault(60),
      Config.validate({
        message: "DELIVERY_LEASE_SECONDS must be 30..300",
        validation: (n) => n >= 30 && n <= 300,
      }),
    );
    const pollSeconds = yield* Config.integer("DELIVERY_POLL_INTERVAL_SECONDS").pipe(
      Config.withDefault(5),
      Config.validate({
        message: "DELIVERY_POLL_INTERVAL_SECONDS must be 1..300",
        validation: (n) => n >= 1 && n <= 300,
      }),
    );
    const maxAttempts = yield* Config.integer("DELIVERY_MAX_ATTEMPTS").pipe(
      Config.withDefault(8),
      Config.validate({
        message: "DELIVERY_MAX_ATTEMPTS must be 1..20",
        validation: (n) => n >= 1 && n <= 20,
      }),
    );
    const graceMinutes = yield* Config.integer("DELIVERY_REMINDER_GRACE_MINUTES").pipe(
      Config.withDefault(15),
      Config.validate({
        message: "DELIVERY_REMINDER_GRACE_MINUTES must be 0..60",
        validation: (n) => n >= 0 && n <= 60,
      }),
    );
    const now = Clock.currentTimeMillis.pipe(Effect.map((millis) => new Date(millis)));

    const queue = (
      current: CurrentAppointment,
      input: DeliveryEnqueueInput,
      currentTime: Date,
      remindersOnly = false,
    ) =>
      Effect.gen(function* () {
        const practitioner = yield* repo.practitionerUserId(current.practitionerProfileId);
        const recipients = [
          ...new Set(
            [current.bookerUserId, current.subjectUserId, practitioner].filter(
              (id): id is string => id !== null && id !== undefined,
            ),
          ),
        ];
        const events = [
          ...(remindersOnly
            ? []
            : [
                {
                  event: input.kind,
                  dueAt: currentTime,
                  expiresAt: new Date(currentTime.getTime() + 23 * 3_600_000),
                  offset: undefined,
                },
              ]),
          ...(current.status !== "confirmed"
            ? []
            : reminderDeadlines(current.startsAt, currentTime, graceMinutes).map((deadline) => ({
                event: "reminder" as const,
                dueAt: deadline.dueAt,
                expiresAt: deadline.expiresAt,
                offset: deadline.offset,
              }))),
        ];
        const rows = [];
        for (const recipientUserId of recipients) {
          const subscriptions = yield* transport.listPushSubscriptions(recipientUserId);
          for (const event of events) {
            for (const channel of [
              { channel: "email", subscription: undefined },
              ...subscriptions.map((subscription) => ({ channel: "push", subscription })),
            ]) {
              const snapshot: DeliverySnapshot = {
                appointmentId: current.id,
                revision: current.revision,
                event: event.event,
                startsAt: current.startsAt.toISOString(),
                endsAt: current.endsAt.toISOString(),
                timezone: current.scheduleTimezone,
                consultationType: current.consultationType,
                ...(input.previousStartsAt !== undefined && {
                  previousStartsAt: input.previousStartsAt.toISOString(),
                }),
                ...(event.offset !== undefined && { reminderOffset: event.offset }),
                ...(channel.subscription !== undefined && {
                  pushSubscription: channel.subscription,
                }),
              };
              rows.push({
                id: yield* ids.next,
                appointmentId: current.id,
                revision: current.revision,
                recipientUserId,
                channel: channel.channel,
                dedupeKey: [
                  current.id,
                  current.revision,
                  event.event,
                  recipientUserId,
                  channel.channel,
                  event.offset ?? "change",
                  channel.subscription?.id ?? "email",
                ].join("/"),
                snapshot,
                dueAt: event.dueAt,
                expiresAt: event.expiresAt,
                createdAt: currentTime,
                updatedAt: currentTime,
              });
            }
          }
        }
        yield* repo.insert(rows);
      });
    const enqueue = (input: DeliveryEnqueueInput) =>
      Effect.gen(function* () {
        const current = yield* repo.current(input.appointmentId);
        if (current === undefined || current.revision !== input.revision) return;
        const currentTime = yield* now;
        yield* repo.suppressPrevious(current.id, current.revision, currentTime);
        yield* queue(current, input, currentTime);
      });
    const process = (row: DeliveryRow, token: string) =>
      Effect.gen(function* () {
        const currentTime = yield* now;
        const finish = (state: string, error?: string) =>
          repo.finish({
            id: row.id,
            token,
            state: state === "suppressed" && row.acceptanceUnknown ? "needs_review" : state,
            now: currentTime,
            ...(error !== undefined && { error }),
          });
        const decoded = DeliverySnapshotDecoder.safeParse(row.snapshot);
        if (!decoded.success) return yield* finish("failed", "Invalid delivery snapshot");
        const snapshot = decoded.data;
        if (row.expiresAt.getTime() <= currentTime.getTime())
          return yield* finish(
            row.acceptanceUnknown ? "needs_review" : "suppressed",
            "Delivery expired",
          );
        if (row.attempts > maxAttempts)
          return yield* finish("needs_review", "Maximum attempts exhausted after lease recovery");
        const current = yield* repo.current(row.appointmentId);
        if (
          current === undefined ||
          current.revision !== row.revision ||
          (snapshot.event === "reminder" &&
            (current.status !== "confirmed" || current.startsAt.getTime() <= currentTime.getTime()))
        )
          return yield* finish("suppressed", "Obsolete appointment revision");
        if (
          row.recipientUserId === current.bookerUserId &&
          (current.subjectUserId !== null || current.dependentId !== null) &&
          !(yield* repo.caregiverActive(
            current.bookerUserId,
            current.subjectUserId,
            current.dependentId,
          ))
        )
          return yield* finish("suppressed", "Caregiver access revoked");
        const contact = yield* repo.contact(row.recipientUserId);
        if (
          contact === undefined ||
          (row.channel === "email" && (!contact.emailEnabled || !contact.emailVerified)) ||
          (row.channel === "push" && !contact.pushEnabled)
        )
          return yield* finish("suppressed", "Recipient unavailable or opted out");
        if (row.channel !== "email" && row.channel !== "push")
          return yield* finish("failed", "Unsupported channel");
        if (row.channel === "push") {
          const subscription = snapshot.pushSubscription;
          if (
            subscription === undefined ||
            !(yield* transport.listPushSubscriptions(row.recipientUserId)).some(
              (item) =>
                item.id === subscription.id &&
                item.endpoint === subscription.endpoint &&
                item.keys.p256dh === subscription.keys.p256dh &&
                item.keys.auth === subscription.keys.auth,
            )
          )
            return yield* finish("suppressed", "Push subscription removed");
        }
        const firstAttempt = row.firstAttemptAt ?? currentTime;
        if (currentTime.getTime() - firstAttempt.getTime() >= 23 * 3_600_000)
          return yield* finish("needs_review", "Provider idempotency retry window elapsed");
        let payload: FrozenDelivery;
        if (row.frozenPayload !== null) {
          const frozen = FrozenDeliveryDecoder.safeParse(row.frozenPayload);
          if (!frozen.success) return yield* finish("failed", "Invalid frozen payload");
          payload = frozen.data;
          if (row.channel === "email" && payload.to !== contact.email)
            return yield* finish("suppressed", "Recipient email changed");
        } else {
          const rendered = renderEmail(
            {
              kind: "appointment",
              event: snapshot.event,
              startsAt: snapshot.startsAt,
              timezone: snapshot.timezone,
              previousStartsAt: snapshot.previousStartsAt,
            },
            contact.locale === "en" ? "en" : "fr",
          );
          payload = {
            to:
              row.channel === "email" ? contact.email : (snapshot.pushSubscription?.endpoint ?? ""),
            subject: rendered.subject,
            html: rendered.html,
            text: rendered.text ?? rendered.subject,
          };
        }
        const sendTime = yield* now;
        if (row.expiresAt.getTime() <= sendTime.getTime())
          return yield* finish(
            row.acceptanceUnknown ? "needs_review" : "suppressed",
            "Delivery expired during preflight",
          );
        if (
          !(yield* repo.freeze({
            id: row.id,
            token,
            payload,
            now: sendTime,
            leaseUntil: new Date(sendTime.getTime() + leaseSeconds * 1000),
          }))
        )
          return;
        const outcome = yield* transport
          .send({
            ...payload,
            appointmentId: snapshot.appointmentId,
            channel: row.channel,
            userId: row.recipientUserId,
            dedupeKey: row.dedupeKey,
            pushSubscription: snapshot.pushSubscription,
          })
          .pipe(
            Effect.timeoutFail({
              duration: "20 seconds",
              onTimeout: () =>
                new DeliveryTransportError({
                  reason: "Provider request timed out",
                  retryable: true,
                  ambiguous: true,
                }),
            }),
            Effect.either,
          );
        const completedAt = yield* now;
        if (outcome._tag === "Right")
          return yield* repo.finish({
            id: row.id,
            token,
            state: "accepted",
            now: completedAt,
            acceptanceUnknown: false,
            ...(outcome.right.providerId !== undefined && { providerId: outcome.right.providerId }),
          });
        const error = outcome.left;
        const terminal = !error.retryable || row.attempts >= maxAttempts;
        yield* repo.finish({
          id: row.id,
          token,
          state: terminal
            ? error.ambiguous || row.acceptanceUnknown
              ? "needs_review"
              : "failed"
            : "pending",
          now: completedAt,
          dueAt: new Date(completedAt.getTime() + retryDelayMillis(row.attempts)),
          error: error.reason.slice(0, 1000),
          acceptanceUnknown: error.ambiguous || row.acceptanceUnknown,
        });
      });
    const runPass = () =>
      Effect.gen(function* () {
        const currentTime = yield* now;
        const token = yield* ids.next;
        const rows = yield* repo.claim({
          now: currentTime,
          limit: Math.min(batchSize, concurrency),
          token,
          leaseUntil: new Date(currentTime.getTime() + leaseSeconds * 1000),
        });
        yield* Effect.forEach(
          rows,
          (row) =>
            process(row, token).pipe(
              Effect.catchAll(() =>
                Effect.logError("Delivery processing failed", { jobId: row.id }),
              ),
            ),
          { concurrency, discard: true },
        );
        return rows.length;
      });
    return {
      enqueue,
      runPass,
      run: () =>
        runPass().pipe(
          Effect.catchAll(() => Effect.logError("Delivery pass failed")),
          Effect.repeat(Schedule.spaced(`${pollSeconds} seconds`)),
          Effect.zipRight(Effect.never),
        ),
      backfill: (input = {}) =>
        Effect.gen(function* () {
          const currentTime = yield* now;
          const rows = yield* repo.futureConfirmed({
            now: currentTime,
            limit: Math.max(1, Math.min(input.limit ?? 100, 100)),
            ...(input.cursor !== undefined && { cursor: input.cursor }),
          });
          for (const row of rows) {
            yield* sql.withTransaction(
              Effect.gen(function* () {
                const current = yield* repo.current(row.id);
                if (current !== undefined && current.status === "confirmed")
                  yield* queue(
                    current,
                    { appointmentId: current.id, revision: current.revision, kind: "confirmed" },
                    currentTime,
                    true,
                  );
              }),
            );
          }
          return { count: rows.length, nextCursor: rows.at(-1)?.id };
        }),
    } satisfies typeof DeliveryService.Service;
  }),
);
