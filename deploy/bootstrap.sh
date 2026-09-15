#!/usr/bin/env bash
# One-time (idempotent) preparation of the VM for a stage. Don't run this file
# directly — use the wrapper, which inlines the sibling files and ssh's in:
#
#   bash deploy/bootstrap dev
#
# What it does (re-running is safe; each step checks before acting):
#   1. Installs Docker + Compose from Ubuntu's repos, with log rotation.
#   2. Creates the unprivileged `deploy` user CI logs in as (docker group, no sudo)
#      and authorizes the committed CI public key (deploy/ci-deploy-key.pub).
#   3. Creates /srv/kanasante/<stage>/ with a .env seeded from deploy/env.example
#      (secrets generated; Resend/AWS keys left for a human to fill in).
#   4. Installs the nginx site for <stage>-api.kanasante.com and, if DNS already
#      points here, obtains a TLS cert with certbot.
# It does NOT deploy the app — CI does that (see docs/deployment.md).
set -euo pipefail

STAGE="${1:?usage: bootstrap.sh <dev|staging|prod>}"
case "$STAGE" in
  dev)     SERVER_NAME=dev-api.kanasante.com;     API_PORT=5100 ;;
  staging) SERVER_NAME=staging-api.kanasante.com; API_PORT=5200 ;;
  prod)    SERVER_NAME=api.kanasante.com;         API_PORT=5300 ;;
  *) echo "unknown stage: $STAGE" >&2; exit 1 ;;
esac
[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)" >&2; exit 1; }

# This file runs alone on the box, so it can't read sibling files — the wrapper
# (deploy/bootstrap) substitutes these placeholders before copying it over.
CI_PUBKEY='__CI_PUBKEY__'
ENV_EXAMPLE_B64='__ENV_EXAMPLE_B64__'
NGINX_TEMPLATE_B64='__NGINX_TEMPLATE_B64__'

DEPLOY_USER=deploy
STAGE_DIR=/srv/kanasante/$STAGE

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

log "1/4 Docker"
if ! command -v docker >/dev/null; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io docker-compose-v2 gettext-base
  systemctl enable --now docker
else
  echo "docker already installed: $(docker --version)"
fi
command -v envsubst >/dev/null || apt-get install -y -qq gettext-base
mkdir -p /etc/docker
if [ ! -f /etc/docker/daemon.json ]; then
  cat > /etc/docker/daemon.json <<'JSON'
{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }
JSON
  systemctl restart docker
fi

log "2/4 deploy user"
if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  useradd --system --create-home --shell /bin/bash --groups docker "$DEPLOY_USER"
fi
usermod -aG docker "$DEPLOY_USER"
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
AUTH_KEYS="/home/$DEPLOY_USER/.ssh/authorized_keys"
touch "$AUTH_KEYS"; chmod 600 "$AUTH_KEYS"; chown "$DEPLOY_USER:$DEPLOY_USER" "$AUTH_KEYS"
grep -qF "$CI_PUBKEY" "$AUTH_KEYS" || echo "$CI_PUBKEY" >> "$AUTH_KEYS"

log "3/4 $STAGE_DIR"
install -d -m 750 -o "$DEPLOY_USER" -g "$DEPLOY_USER" /srv/kanasante "$STAGE_DIR"
if [ ! -f "$STAGE_DIR/.env" ]; then
  gen() { openssl rand -base64 32 | tr -d '\n'; }
  echo "$ENV_EXAMPLE_B64" | base64 -d \
    | sed -e "s|__STAGE__|$STAGE|g" -e "s|__SERVER_NAME__|$SERVER_NAME|g" \
          -e "s|__API_PORT__|$API_PORT|g" -e "s|__IMAGE_TAG__|latest|g" \
    | awk -v g1="$(gen)" -v g2="$(gen)" -v g3="$(gen)" -v g4="$(openssl rand -hex 24)" '
        /^DB_PASSWORD=/          { print "DB_PASSWORD=" g4;          next }
        /^BETTER_AUTH_SECRET=/   { print "BETTER_AUTH_SECRET=" g1;   next }
        /^DATA_ENCRYPTION_KEY=/  { print "DATA_ENCRYPTION_KEY=" g2;  next }
        /^DATA_HMAC_KEY=/        { print "DATA_HMAC_KEY=" g3;        next }
        { print }' > "$STAGE_DIR/.env"
  chown "$DEPLOY_USER:$DEPLOY_USER" "$STAGE_DIR/.env"; chmod 600 "$STAGE_DIR/.env"
  echo "wrote $STAGE_DIR/.env — FILL IN RESEND_API_KEY, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY"
else
  echo "$STAGE_DIR/.env exists — left untouched"
fi

log "4/4 nginx site $SERVER_NAME → 127.0.0.1:$API_PORT"
SITE=/etc/nginx/sites-available/$SERVER_NAME
if [ ! -f "$SITE" ]; then
  echo "$NGINX_TEMPLATE_B64" | base64 -d | SERVER_NAME="$SERVER_NAME" API_PORT="$API_PORT" \
    envsubst '${SERVER_NAME} ${API_PORT}' > "$SITE"
  ln -sf "$SITE" "/etc/nginx/sites-enabled/$SERVER_NAME"
  nginx -t && systemctl reload nginx
else
  echo "$SITE exists — left untouched (certbot may own it now)"
fi
MY_IP=$(curl -s --max-time 3 https://checkip.amazonaws.com || true)
DNS_IP=$(getent ahostsv4 "$SERVER_NAME" | awk 'NR==1{print $1}' || true)
if [ -n "$MY_IP" ] && [ "$MY_IP" = "$DNS_IP" ]; then
  if [ ! -d "/etc/letsencrypt/live/$SERVER_NAME" ]; then
    certbot --nginx -d "$SERVER_NAME" --non-interactive --agree-tos --redirect \
      --keep-until-expiring --reuse-key --register-unsafely-without-email
  else
    echo "cert for $SERVER_NAME already present"
  fi
else
  echo "DNS for $SERVER_NAME → '${DNS_IP:-unset}' but this host is '$MY_IP'."
  echo "Add the A record, then re-run this script to obtain the TLS cert."
fi

log "done. Next: fill in $STAGE_DIR/.env, then let CI deploy (or run deploy/deploy.sh as $DEPLOY_USER)."
