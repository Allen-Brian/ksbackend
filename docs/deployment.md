# Deployment

The API runs as a Docker container on a single EC2 VM in **af-south-1 (Cape Town)** —
`kanasante.com`, `16.28.39.251` — next to the nginx that already serves the marketing site.
Postgres runs on the same box. AWS is used for **S3 only** (file uploads, via an IAM user).

There is deliberately **no SST / IaC layer**: SST provisions AWS-managed compute, and the
decision was to use the existing VM. The app stays 12-factor (`Dockerfile` +
`varlock run -- bun`), so moving a stage to Fargate/whatever later is a compose-file swap, not
an app change.

| Stage     | URL                                 | Host port | Deploys on                  | Enabled                       |
| --------- | ----------------------------------- | --------- | --------------------------- | ----------------------------- |
| `dev`     | `https://dev-api.kanasante.com`     | `5100`    | every push to `main`        | **yes**                       |
| `staging` | `https://staging-api.kanasante.com` | `5200`    | push to `main`, after `dev` | `vars.STAGING_DEPLOY_ENABLED` |
| `prod`    | `https://api.kanasante.com`         | `5300`    | tag `v*`                    | `vars.PROD_DEPLOY_ENABLED`    |

Flip a stage on in GitHub → Settings → Secrets and variables → Actions → Variables. Until then
its job shows as _skipped_ — the wiring is exercised, the target is not touched. Before enabling
`prod`, add required reviewers to the `prod` environment.

## The pipeline (`.github/workflows/ci.yml`)

```
verify ──▶ build ──▶ deploy-dev ──▶ deploy-staging (gated)
 (PRs stop here)      └──────────▶ deploy-prod (tags only, gated)
```

- **verify** — lint · format · tsc · structure/import-boundaries · migration drift · unit+api
  tests · integration tests (Testcontainers). Unchanged from before; PRs run only this.
- **build** — two images from one `Dockerfile`: `runtime` (lean) and `migrate` (has drizzle-kit).
  Pushed to `ghcr.io/kanasante/api` as `sha-<short>` / `sha-<short>-migrate` (immutable) plus a
  moving `main` (or the tag name).
- **deploy-\*** — the composite action `.github/actions/deploy-vm`: `scp deploy/compose.yml`
  to `/srv/kanasante/<stage>/`, stream `deploy/deploy.sh` over SSH (secrets on stdin, never
  argv), then smoke-test the public `/readyz`.

`deploy.sh` on the box: `docker login ghcr.io` (with the job's `GITHUB_TOKEN`) → `pull` →
`compose run --rm migrate` → `compose up -d api` → poll `127.0.0.1:<port>/readyz` → prune old
images. A failed migration or an unhealthy container leaves the **previous** container running.

## What lives where on the VM

```
/srv/kanasante/<stage>/
├── compose.yml   # copied from deploy/compose.yml on every deploy
└── .env          # written ONCE by bootstrap; hand-edited; never touched by CI (mode 600)
/etc/nginx/sites-available/<stage>-api.kanasante.com   # from deploy/nginx/api.conf.template
```

- Containers: `kanasante-<stage>-api-1`, `kanasante-<stage>-db-1`; volume `kanasante-<stage>_pgdata`.
- The API listens on `127.0.0.1:<port>` only; Postgres is not published at all.
- `deploy` = unprivileged system user CI logs in as (docker group, **no sudo**). Its authorized
  key is `deploy/ci-deploy-key.pub`; the private half is the `DEPLOY_SSH_KEY` repo secret.
- Log rotation: Docker `json-file` capped at 3×10 MB per container (the root disk is 6.7 GB).

## Bootstrapping a stage (one-time, needs sudo)

```bash
bash deploy/bootstrap dev        # or staging / prod
```

Idempotent. Installs Docker, creates `deploy`, writes `.env` with generated secrets, installs the
nginx site, and — if the stage's DNS A record already points at the box — obtains a Let's Encrypt
cert via certbot. Then **fill in** `RESEND_API_KEY`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
in `/srv/kanasante/<stage>/.env` and restart: `cd /srv/kanasante/<stage> && docker compose up -d api`.

DNS is on **GoDaddy** (not Route53) — records are added by hand: `A <stage>-api → 16.28.39.251`.

## Environment on a deployed stage

`.env` sets `APP_ENV=<stage>`. `dev` was added to the enum for the hosted dev API: it keeps
local-style infra (clean file scanner, deterministic geocoder, better-auth rate limiting off)
while `varlock` still validates every variable. `staging`/`prod` switch on GuardDuty scanning,
Nominatim geocoding and auth rate limits, and make all secrets required.

Secrets are **not** in GitHub. They live only in the stage's `.env` on the box. The only CI
secret is the SSH key.

## Operating

```bash
ssh kanasante.com                                  # as yourself (sudo) — or as `deploy` for docker
cd /srv/kanasante/dev
docker compose ps
docker compose logs -f --tail 100 api
docker compose run --rm migrate                     # re-run migrations for the pinned IMAGE_TAG
docker compose exec db psql -U kanasante kanasante  # DB shell
```

**Roll back**: `IMAGE_TAG=sha-<previous> GHCR_TOKEN=<token> bash deploy.sh dev` from a checkout,
or re-run the earlier successful workflow run from the Actions tab. Migrations are forward-only.

**Seeding demo accounts** on dev (for the Bruno collection): add the `DEMO_*` variables to
`/srv/kanasante/dev/.env`, then
`docker compose run --rm migrate bunx varlock run -- bun scripts/seed.ts` — note the `migrate`
image does not contain `scripts/`, so this needs a checkout mounted:
`docker compose run --rm -v "$PWD/scripts:/app/scripts" migrate bunx varlock run -- bun scripts/seed.ts`.

## Known limits of this setup

- Single box, single Postgres, no backups yet — fine for `dev`; **not** acceptable for `prod`.
  Before enabling prod: EBS snapshots or `pg_dump` to S3 on a cron, and grow the disk.
- No zero-downtime: the API is unavailable for the few seconds between `up -d api` and ready.
- The VM's 2 GB RAM holds one stage comfortably; running all three there is not the plan.
