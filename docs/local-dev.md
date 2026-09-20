# Local development

Local dev runs the **same real drivers as production** — it just points them at local
emulators, so the code path you exercise locally is identical to prod:

| Concern           | Prod                 | Local                                                          |
| ----------------- | -------------------- | -------------------------------------------------------------- |
| Postgres          | managed DB           | `docker compose` Postgres                                      |
| File storage (S3) | AWS S3               | **LocalStack** S3                                              |
| Email             | Resend (org account) | **Resend** (your personal account)                             |
| Malware scan      | AWS GuardDuty        | ⚠️ clean-fake (see [below](#malware-scanning-is-not-emulated)) |

There are no in-memory fakes on the running server — those exist only in the test suite.
That means local dev needs a one-time LocalStack + Resend setup (below). Nothing here depends
on the PM or CTO: LocalStack gives you S3, and a personal Resend account gives you email.

Prerequisites: [Bun](https://bun.sh) ≥ 1.3, Docker, and the [AWS CLI](https://aws.amazon.com/cli/).

---

## 1. Infra (Postgres + S3) in one command

```bash
bun run infra:up      # starts Postgres + LocalStack, migrates, creates the bucket
bun run infra:down    # stops everything
```

That's the whole setup — you don't create buckets or start containers by hand. `infra:up` is
idempotent, so re-run it anytime. LocalStack provides S3 from its **free Community image** (pinned
in `docker-compose.yml`), so **no auth token or account is required**.

`infra:up` reads the host ports straight from your `.env.local` (the ports in `DATABASE_URL` and
`AWS_ENDPOINT_URL_S3`), so the containers always match what the app connects to — if `5432` is
taken, just set `DATABASE_URL=…@localhost:5433/…` and it follows. (An explicit
`DB_PORT` / `LOCALSTACK_PORT` env still overrides.)

> **Note:** LocalStack's `:latest` tag can resolve to the **Pro** image on machines that also run
> LocalStack Pro (it needs a token). We pin a Community version tag to avoid that entirely.

### Browsing S3

LocalStack Community has **no built-in web UI** — `http://localhost:4566` is the S3 _API_, not a
dashboard. `infra:up` therefore also starts a small S3 browser (`s3manager`):

👉 **http://localhost:8083** — view/upload/download objects in `kanasante-dev`.

Or inspect from the CLI with a throwaway `localstack` AWS profile (LocalStack accepts any
non-empty credentials — dummy, not secrets):

```bash
aws configure set aws_access_key_id test    --profile localstack
aws configure set aws_secret_access_key test --profile localstack
aws configure set region us-east-1           --profile localstack
aws --endpoint-url=http://localhost:4566 --profile localstack s3 ls
```

### How the app reaches it (`.env.local`)

```bash
S3_BUCKET=kanasante-dev
S3_REGION=us-east-1
AWS_ACCESS_KEY_ID=test
AWS_SECRET_ACCESS_KEY=test
AWS_ENDPOINT_URL_S3=http://localhost:4566
S3_FORCE_PATH_STYLE=true
```

`AWS_ENDPOINT_URL_S3` is honored **natively by the AWS SDK** — no app code needed.
`S3_FORCE_PATH_STYLE=true` makes URLs `host/bucket/key` so they work against `localhost` with no
external DNS (real AWS leaves it unset and uses virtual-host). Presigned upload/download URLs the
API returns will point at this endpoint.

> **Mobile note:** presigned URLs at `localhost:4566` won't resolve from an Android emulator
> (`10.0.2.2`) or a physical device (your machine's LAN IP). Set `AWS_ENDPOINT_URL_S3` to the host
> the device can reach — the presigned URL must be signed for the same host the client connects to.

## 2. Email via resend-local

Local email runs against [**resend-local**](https://github.com/y-hiraoka/resend-local) — a local
emulator of the Resend API with a dashboard to view every email (OTP codes, reset links,
notifications). **No Resend account or API key is required** — the key is ignored.

Start it (in its own terminal — it stays running):

```bash
bun run email:local        # runs `bunx resend-local`, serves on http://localhost:8005
```

Then point the app at it. It's already set in `.env.local` (`RESEND_BASE_URL=http://localhost:8005`),
so `bun run dev` uses it automatically. Equivalently, per-run:

```bash
RESEND_BASE_URL=http://localhost:8005 bun run dev
```

The Resend SDK honors `RESEND_BASE_URL` natively, so either form works. Open
**http://localhost:8005** to read whatever the app sent — that's where you grab the sign-up OTP,
password-reset code, etc. when testing flows manually.

### Testing real delivery instead (optional)

To exercise actual Resend delivery, **comment out `RESEND_BASE_URL`** and set a personal key:

```bash
# RESEND_BASE_URL=...        # disabled -> hits the real Resend API
RESEND_API_KEY=re_your_personal_key
```

Sandbox limits apply: with no verified domain, Resend only delivers to **your own account email**
and sends **from** `onboarding@resend.dev`.

## 3. Run it

First time:

```bash
bun run setup        # deps, .env.local, infra (Postgres + LocalStack), migrations
bun run db:seed      # first admin + professions
```

Each session:

```bash
bun run infra:up     # if the containers aren't already up (idempotent)
bun run email:local  # resend-local on :8005 (separate terminal, stays running)
bun run dev          # http://localhost:<PORT>
```

Docs once it's up: `/docs` (Scalar, our `/v1/*` routes) · `/openapi.json` · `/api/auth/reference`
(better-auth's own reference: sign-up, OTP, password reset, email/account management). Captured
email: **http://localhost:8005**.

## 4. Demoing the API with Bruno

`bruno/` is a committed [Bruno](https://www.usebruno.com/) collection mirroring every `/v1`
endpoint (plain-text `.bru` files — diffable, PR-reviewable). Open the folder in the Bruno app,
pick the `local` environment, and run.

One-time setup — uncomment the `DEMO_*` block in `.env.local` (see `.env.local.example`; the
credentials must match `bruno/environments/local.bru`), then:

```bash
bun run db:seed      # demo patient, doctor, admin + a cast of verified practitioners
```

To verify the API in the Bruno app, open `flows/demo`, use the folder menu to run the whole
folder, and keep the requests in sequence order. You should see 12 green requests and 12 passing
tests. The flow captures each sign-in token and the selected practitioner's ID for the later
requests, so it requires no manual variable entry. The equivalent headless check is:

```bash
bun run bruno:demo   # also writes bruno-report.html
```

`flows/booking` is the second story: the appointment lifecycle. The doctor signs in so the flow
can learn her practitioner id, then the patient signs in, opens her profile, reads the next two
weeks of open slots, **holds** the first one (`POST /v1/appointments` → `held`), **confirms** it,
sees it under `GET /v1/me/appointments`, the doctor sees it on that day's
`GET /v1/practitioners/me/agenda`, and finally the patient cancels — so the seed data is left
exactly as it was and the folder can be re-run at will. Expect 13 green requests:

```bash
bun run bruno:booking   # same report file
```

Do not start with `v1/` for the one-click demo. That tree is the exhaustive endpoint catalog;
blank path parameters such as `id` and `token` are intentionally left for the concrete resource
you want when running an individual request.

- **No token copying.** The sign-in requests in `bruno/auth/` (and inside the demo flow) store
  the bearer token from better-auth's `set-auth-token` response header; every `/v1` request
  inherits it from the collection-level auth. Sign in as a different account to switch identity.
- **`bruno/flows/demo/`** is a curated, numbered story — patient signs in → searches → opens a
  doctor → availability → reviews → doctor side → admin verification queue. One click on the
  folder in Bruno's Runner (or headless: `bun run bruno:demo`, which writes `bruno-report.html`,
  a shareable run report). **`bruno/flows/booking/`** is the same idea for booking: hold →
  confirm → both sides see it → cancel (`bun run bruno:booking`).
- **`bruno/v1/`** holds one request per OpenAPI operation, foldered by resource (`appointments/`
  carries the hold/confirm/cancel catalog entries with the 409 outcomes documented). It is generated
  by `bun run bruno:scaffold` and ENFORCED by `test/api/bruno-coverage.api.test.ts` (part of
  `bun run test`): a new endpoint without a Bruno request fails the build — run the scaffold and
  commit the new file (existing files are never overwritten, so hand-tuned bodies survive).
- Sign-in requests send an explicit `Origin` header: better-auth rejects cookie-bearing
  state-changing requests without one (`MISSING_OR_NULL_ORIGIN`), and Bruno's cookie jar always
  replays the previous session cookie.

### Port collisions

If `5432` (Postgres) or your chosen `PORT` are taken, shift them:

```bash
DB_PORT=5433 docker compose up -d db     # host port for Postgres
```

…and set `DATABASE_URL=…@localhost:5433/…`, `PORT`, `BETTER_AUTH_URL`, `CORS_ORIGINS` in
`.env.local` to match.

---

## Malware scanning is not emulated

Production scans uploads with **AWS GuardDuty Malware Protection for S3** (the `FileScanner`
reads GuardDuty's scan-result object tags). LocalStack does not emulate GuardDuty, so **local
dev uses a clean-fake scanner**: every upload is treated as clean. The `FILE_INFECTED` rejection
path is covered by the API tests (`test/api/practitioner.api.test.ts`), not reproducible locally.

## `.env.local` reference (local values)

```bash
APP_ENV=local
PORT=5000
DATABASE_URL=postgres://kanasante:kanasante@localhost:5433/kanasante
BETTER_AUTH_URL=http://localhost:5000
CORS_ORIGINS=http://localhost:5000

ADMIN_SEED_EMAIL=admin@kanasante.local
ADMIN_SEED_PASSWORD=admin-dev-password-123

# S3 via LocalStack
S3_BUCKET=kanasante-dev
S3_REGION=us-east-1
AWS_ACCESS_KEY_ID=test
AWS_SECRET_ACCESS_KEY=test
AWS_ENDPOINT_URL_S3=http://localhost:4566
S3_FORCE_PATH_STYLE=true

# Email via resend-local (key ignored; view at http://localhost:8005)
RESEND_API_KEY=re_local_placeholder
EMAIL_FROM=KanaSanté <onboarding@resend.dev>
RESEND_BASE_URL=http://localhost:8005
```
