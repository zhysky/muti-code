#!/usr/bin/env bash
set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:-de.minakami-yuki.com}"
REMOTE_DIR="${REMOTE_DIR:-/opt/muti-code}"
REPO_URL="${REPO_URL:-https://github.com/zhysky/muti-code.git}"
DEPLOY_REF="${DEPLOY_REF:-origin/master}"
PUBLIC_HOST="${PUBLIC_HOST:-$REMOTE_HOST}"
PUBLIC_PORT="${PUBLIC_PORT:-18443}"
PUBLIC_URL="${PUBLIC_URL:-https://${PUBLIC_HOST}:${PUBLIC_PORT}}"
TLS_CERT_PATH="${TLS_CERT_PATH:-/etc/v2ray-agent/tls/${PUBLIC_HOST}.crt}"
TLS_KEY_PATH="${TLS_KEY_PATH:-/etc/v2ray-agent/tls/${PUBLIC_HOST}.key}"

log() {
  printf '[deploy] %s\n' "$*"
}

quote() {
  printf '%q' "$1"
}

remote_command=(
  "REMOTE_DIR=$(quote "$REMOTE_DIR")"
  "REPO_URL=$(quote "$REPO_URL")"
  "DEPLOY_REF=$(quote "$DEPLOY_REF")"
  "PUBLIC_HOST=$(quote "$PUBLIC_HOST")"
  "PUBLIC_PORT=$(quote "$PUBLIC_PORT")"
  "TLS_CERT_PATH=$(quote "$TLS_CERT_PATH")"
  "TLS_KEY_PATH=$(quote "$TLS_KEY_PATH")"
  "bash -s"
)

log "deploying ${DEPLOY_REF} to ${REMOTE_HOST}:${REMOTE_DIR}"
ssh -o BatchMode=yes "$REMOTE_HOST" "${remote_command[*]}" <<'REMOTE'
set -euo pipefail

log() {
  printf '[remote] %s\n' "$*"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf '[remote] missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

read_minimax_key_from_file() {
  file="$1"
  [ -r "$file" ] || return 0
  line="$(grep -m1 -E '^(export[[:space:]]+)?MINIMAX_API_KEY=' "$file" || true)"
  [ -n "$line" ] || return 0
  value="${line#export }"
  value="${value#MINIMAX_API_KEY=}"
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"
  if [ -n "$value" ]; then
    MINIMAX_API_KEY="$value"
    export MINIMAX_API_KEY
  fi
}

require_command git
require_command docker
require_command curl

mkdir -p "$(dirname "$REMOTE_DIR")"
if [ -d "$REMOTE_DIR/.git" ]; then
  log "updating existing repository"
  cd "$REMOTE_DIR"
  git remote set-url origin "$REPO_URL"
else
  log "cloning repository"
  git clone "$REPO_URL" "$REMOTE_DIR"
  cd "$REMOTE_DIR"
fi

git fetch origin --prune
git reset --hard "$DEPLOY_REF"

if [ -z "${MINIMAX_API_KEY:-}" ] && [ -f "$REMOTE_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$REMOTE_DIR/.env"
  set +a
fi
if [ -z "${MINIMAX_API_KEY:-}" ]; then
  read_minimax_key_from_file "$HOME/.bashrc"
fi
if [ -z "${MINIMAX_API_KEY:-}" ]; then
  read_minimax_key_from_file "/root/.bashrc"
fi
if [ -z "${MINIMAX_API_KEY:-}" ]; then
  read_minimax_key_from_file "/etc/environment"
fi
if [ -z "${MINIMAX_API_KEY:-}" ]; then
  printf '[remote] MINIMAX_API_KEY was not found in env, .env, bashrc, or /etc/environment\n' >&2
  exit 1
fi

umask 077
cat > "$REMOTE_DIR/.env" <<EOF
AGENT_DRIVER_MODE=real
ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic
INTERNAL_LLM_BASE_URL=https://api.minimaxi.com/v1
MINIMAX_API_KEY=${MINIMAX_API_KEY}
WEB_ALLOWED_HOSTS=${PUBLIC_HOST}
EOF

if command -v nginx >/dev/null 2>&1; then
  log "writing nginx reverse proxy on ${PUBLIC_PORT}"
  cat > /etc/nginx/conf.d/muti-code.conf <<EOF
server {
    listen ${PUBLIC_PORT} ssl so_keepalive=on;
    http2 on;
    server_name ${PUBLIC_HOST};

    ssl_certificate     ${TLS_CERT_PATH};
    ssl_certificate_key ${TLS_KEY_PATH};

    ssl_protocols              TLSv1.2 TLSv1.3;
    ssl_ciphers                TLS13_AES_128_GCM_SHA256:TLS13_AES_256_GCM_SHA384:TLS13_CHACHA20_POLY1305_SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305;
    ssl_prefer_server_ciphers  on;

    client_max_body_size 30m;

    location / {
        proxy_pass         http://127.0.0.1:5173;
        proxy_http_version 1.1;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_buffering    off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
EOF
  nginx -t
  systemctl reload nginx
else
  log "nginx not found; skipping reverse proxy setup"
fi

log "building and restarting docker compose services"
docker compose --env-file .env -f deploy/docker-compose.yml up --build -d

log "checking local service health"
curl -fsS http://127.0.0.1:3000/readyz >/dev/null
runtime="$(curl -fsS http://127.0.0.1:5173/api/runtime)"
printf '%s\n' "$runtime" | grep -q '"driver_mode":"real"'
printf '%s\n' "$runtime" | grep -q '"minimax_ready":true'
docker compose --env-file .env -f deploy/docker-compose.yml ps
log "deployed $(git rev-parse --short HEAD)"
REMOTE

log "checking public endpoint ${PUBLIC_URL}"
runtime="$(curl -fsS "${PUBLIC_URL}/api/runtime")"
printf '%s\n' "$runtime" | grep -q '"driver_mode":"real"'
printf '%s\n' "$runtime" | grep -q '"minimax_ready":true'
printf '%s\n' "$runtime"
log "deployment complete"
