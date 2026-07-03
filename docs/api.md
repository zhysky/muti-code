# API

Swagger UI is available at `/docs` when the API server is running.

## Core Endpoints

- `GET /healthz`
- `GET /readyz`
- `GET /metrics`
- `GET /api/agents`
- `GET /api/agents/{agent}/models`
- `GET /api/agents/{agent}/health`
- `POST /api/sessions`
- `GET /api/sessions`
- `GET /api/sessions/{session_id}`
- `POST /api/sessions/{session_id}/agent`
- `POST /api/sessions/{session_id}/reset`
- `DELETE /api/sessions/{session_id}`
- `POST /api/sessions/{session_id}/messages`
- `POST /api/sessions/{session_id}/messages/stream`
- `GET /api/sessions/{session_id}/messages`
- `GET /api/runs/{run_id}`
- `GET /api/runs/{run_id}/events`
- `GET /api/runs/{run_id}/debug-events`
- `POST /api/runs/{run_id}/abort`
- `GET /api/workspaces`
- `POST /api/workspaces`
- `GET /api/workspaces/{workspace_id}/files`
- `GET /api/workspaces/{workspace_id}/diff`
- `POST /api/workspaces/{workspace_id}/reset`
- `POST /api/workspaces/{workspace_id}/snapshot`
- `POST /api/im/internal/webhook`
- `POST /api/im/feishu/webhook`
- `POST /api/im/wecom/webhook`

## Idempotency

`POST /api/sessions/{session_id}/messages` accepts `Idempotency-Key`.

- same key + same request hash returns the first `run_id`;
- same key + different hash returns `409`;
- `workspace-write` requests must provide the header;
- the web client and internal IM adapter generate keys by default.

## SSE

`GET /api/runs/{run_id}/events` replays stored events and streams new events:

```text
event: text.delta
data: {"seq":2,"type":"text.delta","runId":"run_x","text":"..."}
```

`POST /api/sessions/{session_id}/messages/stream` accepts the same body as `POST /messages` and keeps the response open as SSE. It returns `x-message-id`, `x-run-id`, and `x-stream-url` headers before streaming the same sanitized `AgentEvent` payloads.

Raw debug events are disabled in v1 because raw tool output must not be persisted by default.
