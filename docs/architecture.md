# Architecture

```text
Browser / HTTP API / IM
  -> Fastify Gateway
  -> AgentRouter + ModelRouter
  -> RunService / SessionService / WorkspaceManager
  -> AgentDriver interface
  -> ClaudeDriver / CodexDriver / OpenCodeDriver
```

## Layers

- `apps/api`: Fastify REST, SSE, Swagger, IM webhooks, health endpoints.
- `apps/web`: React + Vite browser demo.
- `packages/core`: router, run orchestration, workspace locks, permission policy, sanitizer, event bus, shared types.
- `packages/drivers`: unified `AgentDriver` implementations. Mock mode is default; real mode uses CLI/HTTP fallback where SDKs are unavailable.
- `packages/db`: PostgreSQL schema plus in-memory repository for local tests.
- `packages/im`: IM adapter contract and internal webhook implementation.
- `packages/security`: auth/signing/sanitizer exports.
- `packages/observability`: structured logger and metrics helpers.

## Event Flow

Raw driver event -> sanitizer -> Redis Stream / Postgres `run_events` -> SSE / Web / IM.

The API never exposes Claude/Codex/OpenCode native events directly. Each driver maps output to `AgentEvent`.

## Locking And Abort

`RunService` acquires a workspace write lock only for `workspace-write` runs. The lock is released in `finally` for completed, failed, aborted, and timeout paths. Abort calls the driver and emits a terminal `run.aborted` event when needed.

## Model Routing

Agent and model are separate fields. `ModelRouter` rejects models not explicitly enabled for the selected agent, so the frontend cannot submit arbitrary provider model IDs.
