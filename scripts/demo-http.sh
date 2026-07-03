#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"

session_json="$(curl -sS -X POST "$BASE_URL/api/sessions" \
  -H 'content-type: application/json' \
  -d '{"title":"demo session","agent":"codex","model":"gpt-5-codex","workspace_id":"sample-project","permission_profile":"workspace-write"}')"

session_id="$(node -e 'const data=JSON.parse(process.argv[1]); console.log(data.id)' "$session_json")"
run_json="$(curl -sS -X POST "$BASE_URL/api/sessions/$session_id/messages" \
  -H 'content-type: application/json' \
  -H "Idempotency-Key: demo-$(date +%s)" \
  -d '{"content":"请创建一个 AGENT_OUTPUT.md 文件","agent":"codex","model":"gpt-5-codex","stream":true,"permission_profile":"workspace-write"}')"

run_id="$(node -e 'const data=JSON.parse(process.argv[1]); console.log(data.run_id)' "$run_json")"
echo "session_id=$session_id"
echo "run_id=$run_id"
echo "SSE:"
curl -N "$BASE_URL/api/runs/$run_id/events"
