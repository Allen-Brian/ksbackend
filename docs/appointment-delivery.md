# Appointment changes and delivery

This work implements SCRUM-19 and the email/Web Push portion of SCRUM-20. SMS is
explicitly deferred pending the team's provider and product decision.

## Delivery guarantees

Appointment state and notification jobs commit in the same Postgres transaction.
Provider failures do not undo an appointment. A failed appointment mutation does
not commit notification work. Retried mutations must not create duplicate jobs.

Confirmation, cancellation and rescheduling messages target the booker,
practitioner and linked patient where applicable, with duplicate identities
removed. Managed dependents have no account/email; the booker receives their email.
No emergency contact is silently used as a delivery recipient.

Recipient locale and appointment channel preferences are checked before sending.
Consultation language does not determine notification language. Messages contain
appointment details, never diagnoses or unrelated clinical information.

Workers claim due work with expiring leases. Every acknowledgement is fenced by
its lease token. Expired leases can be recovered after a crash. A frozen provider
request is reused across retries so its idempotency key remains meaningful.
Resend retains idempotency keys for 24 hours; ambiguous results outside the bounded
automatic retry window need operator review. Provider acceptance does not prove
inbox delivery. Web Push does not provide equivalent provider-side deduplication;
clients must use the supplied notification tag to replace duplicate notifications.

Cancellation and rescheduling suppress obsolete queued reminders. A message
already in flight at the provider cannot be recalled. Reminders never send after
appointment start, and missed thresholds at booking are skipped rather than sent
immediately. A bounded lateness grace permits recovery after brief downtime.

## Rollout

1. Apply additive migrations and preserve the deployed cancellation cutoff when
   backfilling existing appointments. Doctor policy changes must not rewrite the
   cancellation terms of already-booked appointments.
2. Deploy with the delivery worker disabled. Queueing may operate while dispatch
   is disabled; monitor job age before enabling dispatch.
3. Configure real Resend or local `resend-local` capture. For Web Push, generate
   VAPID keys, configure their contact subject, and coordinate the service-worker
   payload contract with the frontend. Do not commit private keys.
4. Run confirmation -> reschedule -> cancellation smoke checks with controlled
   recipients. Check authoritative slot availability, agenda, queued jobs and
   captured messages. Validate FR and EN recipients and disabled preferences.
5. Backfill applicable future reminders for existing confirmed appointments in
   bounded, cursor-based batches. Logical delivery keys make repeat runs safe.
6. Enable the worker and inspect pending age, retries, failed/suppressed work and
   expired leases. Exercise restart recovery before declaring rollout complete.

The VM's stage `.env` is operator-maintained; CI does not populate new credentials.
Worker settings have safe defaults so older stages can still start without VAPID
credentials. Web Push registration must report unavailable rather than expose a
fake public key when push is not configured.

## Rollback

Disable delivery first, then redeploy the previous compatible immutable `sha-*`
image using the deployment runbook. Keep migrations forward-compatible and leave
committed jobs intact for recovery. Never drop pending jobs to hide a failure.
The current deployment script does not automatically restore the old API image
if readiness fails after replacement; explicitly verify the restored image's
`/readyz` and appointment read paths.

## Acceptance verification

Every PR runs `bun run check`; API tests use real Postgres through Testcontainers
and require Docker. Infrastructure changes also run `bun run test:integration`.
Race tests must prove competing moves retain the losing appointment's original
reservation, and confirm/cancel/move produce coherent final slot state. Delivery
checks exercise rollback, competing workers, expired leases, stale acknowledgements,
provider outages, retry payload stability, opt-out, stale reminder suppression and
restart recovery. Use `bun run test`, never Bun's built-in `bun test` runner.

## Worker controls and backfill

`DELIVERY_WORKER_ENABLED=false` is the default. Set it to `true` to run the
supervised polling worker alongside the API; shutdown interrupts it before the
runtime and database close. Multiple API instances can dispatch safely through
Postgres `FOR UPDATE SKIP LOCKED`, expiring leases and fenced acknowledgements.
No separate queue broker is required.

The remaining controls are `DELIVERY_POLL_INTERVAL_SECONDS` (1..300, default 5),
`DELIVERY_BATCH_SIZE` (1..100, default 20), `DELIVERY_CONCURRENCY` (1..20, default 4),
`DELIVERY_LEASE_SECONDS` (30..300, default 60), `DELIVERY_MAX_ATTEMPTS` (1..20,
default 8) and `DELIVERY_REMINDER_GRACE_MINUTES` (0..60, default 15). Each pass
claims at most the lesser of batch size and concurrency, so a claimed job does
not wait behind another provider request while its lease runs out. Provider calls
have a 20-second outer timeout; the push SDK has a 10-second network timeout.
Zero reminder grace suppresses reminders as soon as they become due.

Run `bun run delivery:backfill` with the worker disabled after migration. It queues
only future reminder thresholds for at most 1,000 confirmed appointments per
invocation, in batches of 100. It sends no historical confirmation receipts and
never calls a delivery provider. Repeating it is safe because delivery keys are
unique. When JSON output includes `nextCursor`, set `DELIVERY_BACKFILL_CURSOR`
to that UUID and invoke it again. Omission of `nextCursor` means the scan completed.
New bookings enqueue through their normal transaction during the scan.
The production image includes this command: use the stage compose environment
and run `bun run delivery:backfill` as a one-shot API container, without starting
its normal server command.

Inspect `notification_delivery` for pending age, expired leases, attempts and
`failed`/`needs_review` states. `accepted` means provider acceptance, not device
or inbox delivery. A process crash after request preparation is conservatively
tracked as potentially accepted; cancellation preserves that uncertainty. Before
resolving a `needs_review` email, correlate its logical key and any provider ID
with Resend. Do not blindly replay ambiguous messages after the provider's
idempotency window. Delivery logs identify job IDs without logging recipients,
payloads or raw provider errors.

Web Push uses the registration and frontend payload contract in
[web-push.md](./web-push.md). A removed or rotated subscription suppresses its
old queued jobs. A provider 404/410 removes only the matching subscription keys,
so it cannot delete a concurrent refresh. The frontend must register before the
appointment event is queued; registering later does not replay existing notices.

## Review stack and delegated work

The implementation is split into appointment transition safety, snapshotted
doctor policies, atomic rescheduling, browser push registration/providers, durable
notification delivery, and rollout/backfill. These are separate PR layers in
GitHub's native stack, reviewed and merged from the bottom upward.

The appointment subagent implemented policies, moves and race/rollback tests;
the push subagent implemented the provider, subscription security and browser
handoff; the delivery subagent implemented the queue, retry/reminder policy and
Postgres lease tests. The parent integrated migrations, application layers,
transactional enqueue, supervised server lifecycle and operator rollout. A second
review pass checked lock ordering and provider ambiguity, followed by API tests
that drive real bookings through the worker with a controlled clock.
