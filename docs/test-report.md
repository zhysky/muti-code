# Test Report

Run:

```bash
npm test
npm run build
npm run phase0
```

Current coverage areas:

- Driver contract behavior for Claude, Codex, OpenCode mock drivers.
- Permission consistency for read-only and workspace-write.
- Abort releases workspace lock.
- Runtime session persistence directories and Codex Responses API config.
- SSE replay from event bus/repository.
- IM event dedup.
- Sanitizer before persistence.
- Idempotency-Key semantics.
- OpenCode headless permission config.
- ModelRouter validation.
- AgentRouter health.

## Local Verification

- `npm test`: 3 files, 34 tests passed.
- `npm run build`: Vite production build and TypeScript check passed.
- `npm run phase0`: runtime check document regenerated; Claude SDK real call is blocked until `ANTHROPIC_API_KEY` or `MINIMAX_API_KEY` is available. OpenCode real file-edit verification is blocked until live model credentials are available.
- `podman compose -f deploy/docker-compose.yml config`: blocked locally because the Podman socket/machine is not running; this environment has Podman installed but no active connection.

## Review Follow-Up Coverage

- Sanitizer regression coverage for PEM private keys, bearer tokens, URL credentials, `_authToken`, metadata URLs, object secret fields, and `.env` paths.
- Workspace id validation rejects path-special ids such as `.`, `..`, and absolute paths.
- Workspace read APIs no longer rewrite `opencode.json`; reset/snapshot reject locked workspaces.
- Abort emits a terminal event and force releases the in-process lock if a driver does not cooperate with abort.
- Abort-before-start is guarded so a cancelled workspace-write run cannot acquire the lock later and start writing.
- Redis publish failure no longer prevents in-memory replay or turns a persisted event into a run failure.
- Redis replay is merged with in-memory/durable events so a partial stream does not hide terminal events.
- Expired idempotency records are ignored, and new requests reserve/update keys instead of check-then-insert only.
- Web preview image ships a Vite preview proxy config, and compose binds demo ports to localhost with explicit `AUTH_DISABLED`.
- IM `/abort` aborts the latest active run in the conversation instead of returning only HTTP guidance.
