#!/usr/bin/env bash
# Deploy one stage on the VM. Run as the `deploy` user, normally by CI:
#
#   { echo "GHCR_TOKEN=…"; echo "IMAGE_TAG=sha-abc1234"; cat deploy/deploy.sh; } | ssh deploy@host bash -s -- dev
#
# Preconditions: bootstrap.sh has run for this stage, and CI has scp'd the
# current deploy/compose.yml to /srv/kanasante/<stage>/compose.yml.
# Steps: log in to GHCR → pull → run migrations (one-shot) → swap the api
# container → verify /readyz → prune old images. Any failure exits non-zero and
# leaves the previous api container running (compose only replaces it on `up`).
# Prints DEPLOY_OK as the very last line on success; the CI action requires it.
#
# The body lives in main() and runs with stdin closed: this script arrives on
# bash's stdin, and `docker compose run` would otherwise attach the migrate
# container to that stream and eat the rest of the script (first dev deploy:
# migrations ran, the api was never started, exit code 0).
set -euo pipefail

main() {

  STAGE="${1:?usage: deploy.sh <dev|staging|prod>}"
  : "${IMAGE_TAG:?IMAGE_TAG must be set (e.g. sha-abc1234)}"
  : "${GHCR_TOKEN:?GHCR_TOKEN must be set (a token with read:packages)}"
  GHCR_USER="${GHCR_USER:-github-actions}"
  STAGE_DIR=/srv/kanasante/$STAGE
  cd "$STAGE_DIR"

  # Pin the tag for this stage: compose reads IMAGE_TAG from .env, so the value
  # survives reboots (`restart: unless-stopped` re-creates from the same tag).
  sed -i "s|^IMAGE_TAG=.*|IMAGE_TAG=$IMAGE_TAG|" .env
  # Read only what this script needs. Never `source` a dotenv file in bash —
  # values like `EMAIL_FROM=Name <addr>` are valid for compose but not for bash.
  envval() { grep -E "^$1=" .env | head -1 | cut -d= -f2- | tr -d '\r'; }
  IMAGE="$(envval IMAGE)"; API_PORT="$(envval API_PORT)"
  : "${IMAGE:?IMAGE missing from .env}" "${API_PORT:?API_PORT missing from .env}"

  echo "==> [$STAGE] deploying $IMAGE:$IMAGE_TAG"
  echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin >/dev/null
  # Small disk: drop every image not backing a running container BEFORE pulling,
  # so the new image only has to fit next to the one currently serving.
  docker image prune -af >/dev/null
  docker compose pull --quiet
  docker compose up -d db
  docker compose run --rm -T migrate
  docker compose up -d --remove-orphans api

  echo "==> waiting for /readyz on 127.0.0.1:$API_PORT"
  for i in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$API_PORT/readyz" >/dev/null; then
      echo "ready after ${i}s"; docker image prune -af >/dev/null; docker logout ghcr.io >/dev/null
      echo DEPLOY_OK
      return 0
    fi
    sleep 1
  done
  echo "api did not become ready; recent logs:" >&2
  docker compose logs --tail 50 api >&2
  return 1
}

main "$@" </dev/null
