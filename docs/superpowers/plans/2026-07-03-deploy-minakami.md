# Deploy de.minakami-yuki.com Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy `zhysky/muti-code.git` to `de.minakami-yuki.com` and verify Claude Code, Codex, and OpenCode can each create a new session and respond through the web/API flow.

**Architecture:** Use the existing Docker Compose topology in `deploy/docker-compose.yml`: `gateway`, `web`, `opencode`, `postgres`, and `redis`. Keep app containers bound to `127.0.0.1` and expose the public domain through the target machine reverse proxy to `127.0.0.1:5173`.

**Tech Stack:** Node 20, npm workspaces, Fastify API, React/Vite web shell, Docker Compose, Postgres 16, Redis 7, MiniMax API, bash on the target machine.

---

### Task 1: Confirm Local Deployment Contract

**Files:**
- Read: `deploy/docker-compose.yml`
- Read: `apps/web/vite.preview.config.mjs`
- Read: `apps/api/src/app.ts`
- Read: `config/agents.yaml`
- Read: `config/models.yaml`

- [ ] **Step 1: Confirm public entrypoint**

Run:

```bash
sed -n '1,220p' deploy/docker-compose.yml
sed -n '1,120p' apps/web/vite.preview.config.mjs
```

Expected: `web` publishes `127.0.0.1:5173:5173`, `gateway` publishes `127.0.0.1:3000:3000`, and Vite preview proxies `/api`, `/healthz`, `/readyz`, `/metrics`, and `/docs` to `http://gateway:3000`.

- [ ] **Step 2: Confirm real driver mode requirements**

Run:

```bash
sed -n '150,190p' apps/api/src/app.ts
sed -n '1,220p' config/agents.yaml
sed -n '1,260p' config/models.yaml
```

Expected: `/api/runtime` reports `driver_mode`, `minimax_ready`, and `opencode_base_url`; all three agents are enabled and default to MiniMax-backed models.

### Task 2: Prepare Target Machine

**Files:**
- Remote path: `/opt/muti-code`
- Remote file: `/opt/muti-code/.env`

- [ ] **Step 1: Connect to target bash shell**

Run:

```bash
ssh -o BatchMode=yes -o ConnectTimeout=8 de.minakami-yuki.com 'echo "$SHELL"; command -v bash; command -v docker; docker --version; docker compose version'
```

Expected: command exits 0, shell is bash-compatible, Docker and Docker Compose are installed.

- [ ] **Step 2: Clone or update repository**

Run on target:

```bash
sudo mkdir -p /opt
sudo chown "$USER":"$USER" /opt
if [ -d /opt/muti-code/.git ]; then
  cd /opt/muti-code
  git fetch origin
  git reset --hard origin/master
else
  git clone https://github.com/zhysky/muti-code.git /opt/muti-code
  cd /opt/muti-code
fi
```

Expected: `/opt/muti-code` exists and points at the latest `origin/master`.

- [ ] **Step 3: Write runtime environment**

Run on target:

```bash
cd /opt/muti-code
cat > .env <<'EOF'
AGENT_DRIVER_MODE=real
ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic
INTERNAL_LLM_BASE_URL=https://api.minimaxi.com/v1
EOF
if [ -n "${MINIMAX_API_KEY:-}" ]; then
  printf 'MINIMAX_API_KEY=%s\n' "$MINIMAX_API_KEY" >> .env
fi
```

Expected: `.env` contains `AGENT_DRIVER_MODE=real` and a non-empty `MINIMAX_API_KEY`.

### Task 3: Start Containers

**Files:**
- Remote file: `/opt/muti-code/deploy/docker-compose.yml`

- [ ] **Step 1: Build and start services**

Run on target:

```bash
cd /opt/muti-code
docker compose --env-file .env -f deploy/docker-compose.yml up --build -d
```

Expected: command exits 0 and starts `gateway`, `web`, `opencode`, `postgres`, and `redis`.

- [ ] **Step 2: Confirm service health**

Run on target:

```bash
cd /opt/muti-code
docker compose --env-file .env -f deploy/docker-compose.yml ps
curl -fsS http://127.0.0.1:3000/readyz
curl -fsS http://127.0.0.1:5173/api/runtime
```

Expected: all containers are running; `/readyz` returns `{"status":"ready"}`; `/api/runtime` returns `driver_mode:"real"` and `minimax_ready:true`.

### Task 4: Configure Public Domain

**Files:**
- Remote reverse-proxy config depends on installed proxy. Prefer existing Nginx/Caddy if already configured.

- [ ] **Step 1: Detect proxy**

Run on target:

```bash
command -v nginx || true
command -v caddy || true
sudo nginx -t 2>/dev/null || true
sudo caddy validate --config /etc/caddy/Caddyfile 2>/dev/null || true
```

Expected: identify the active reverse proxy without replacing unrelated host config.

- [ ] **Step 2: Point domain to web service**

For Nginx, install or update only the `de.minakami-yuki.com` server block:

```nginx
server {
  server_name de.minakami-yuki.com;

  location / {
    proxy_pass http://127.0.0.1:5173;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

For Caddy, add:

```caddy
de.minakami-yuki.com {
  reverse_proxy 127.0.0.1:5173
}
```

Expected: `curl -fsS https://de.minakami-yuki.com/api/runtime` returns the same runtime status as localhost.

### Task 5: Verify Three Agent Bases

**Files:**
- No source edits required.

- [ ] **Step 1: Run API-level smoke verification**

Run from any machine that can reach the domain:

```bash
BASE_URL=https://de.minakami-yuki.com
for agent in claude codex opencode; do
  case "$agent" in
    claude) model=minimax-m3-claude ;;
    codex) model=minimax-m3-codex ;;
    opencode) model=opencode-minimax-m3 ;;
  esac
  session_json="$(curl -fsS -X POST "$BASE_URL/api/sessions" \
    -H 'content-type: application/json' \
    -d "{\"title\":\"deploy smoke $agent\",\"agent\":\"$agent\",\"model\":\"$model\",\"permission_profile\":\"read-only\"}")"
  session_id="$(node -e 'const data=JSON.parse(process.argv[1]); console.log(data.id)' "$session_json")"
  run_json="$(curl -fsS -X POST "$BASE_URL/api/sessions/$session_id/messages" \
    -H 'content-type: application/json' \
    -H "Idempotency-Key: deploy-$agent-$(date +%s)" \
    -d "{\"content\":\"用一句中文回复：$agent 部署验证通过\",\"agent\":\"$agent\",\"model\":\"$model\",\"stream\":true,\"permission_profile\":\"read-only\"}")"
  run_id="$(node -e 'const data=JSON.parse(process.argv[1]); console.log(data.run_id)' "$run_json")"
  sleep 20
  curl -fsS "$BASE_URL/api/runs/$run_id"
  curl -fsS "$BASE_URL/api/sessions/$session_id/messages"
done
```

Expected: each run reaches `completed`, and each session has an assistant message with non-empty content.

- [ ] **Step 2: Run browser-level acceptance**

Open `https://de.minakami-yuki.com/`, create a new chat for each agent selector value, send a short Chinese prompt, and confirm the assistant response is visible in the message list.

Expected: Claude Code, Codex, and OpenCode each respond in newly created sessions from the web page.
