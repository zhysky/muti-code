# Phase 0 Runtime Check

Generated at: 2026-07-03T03:06:49.525Z

This demo prefers mock drivers unless `AGENT_DRIVER_MODE=real` is set. Missing SDK/API credentials are marked as blocked instead of faked as runtime success.

| Check | Status | Evidence |
| --- | --- | --- |
| Claude CLI installed | pass | 2.1.198 (Claude Code) |
| Claude Agent SDK custom API | blocked | ANTHROPIC_API_KEY and MINIMAX_API_KEY are missing; SDK package available=true, but runtime call is blocked. ClaudeDriver SDK/mock contracts are implemented. |
| Codex CLI installed | pass | codex-cli 0.142.5 |
| Codex internal provider uses Responses API | pass | /Users/zhanghengyuan/Documents/github/muti-code/data/runtime/codex/config.toml contains wire_api = "responses"; no Chat Completions compatibility layer is generated. MiniMax-M3 can be tested through https://api.minimaxi.com/v1/responses with MINIMAX_API_KEY. |
| OpenCode CLI installed | pass | 1.17.13 |
| OpenCode headless serve | pass | opencode serve accepted HTTP on port 4196. |
| OpenCode workspace-write no ask mode | pass | WorkspaceManager generated explicit opencode.json with edit allow and default bash deny for workspace-write. |
| OpenCode real workspace-write file edit | blocked | OpenCodeDriver is wired through `opencode run --format json --attach`, but a real file-edit check needs live model credentials such as MINIMAX_API_KEY. |
| Claude/Codex runtime state persistence mounts | pass | Local runtime directories exist and deploy/docker-compose.yml mounts them to /runtime/claude and /runtime/codex. |
| read-only permission baseline | pass | read-only workspace path: /Users/zhanghengyuan/Documents/github/muti-code/workspaces/sample-project. Gateway policy denies write before driver invocation; mock contract tests verify no file.changed event. |
| Gateway workspace-write controlled write | pass | Gateway workspace path accepts controlled writes inside workspace; this is not evidence that all real drivers performed a write. |
| abort releases workspace lock | pass | RunService releases workspace write lock in finally; tests cover abort then immediate second write run. |

## Decisions

- Codex provider configuration is generated with `wire_api = "responses"` only.
- Claude and Codex runtime state are persisted under `data/runtime/claude` and `data/runtime/codex` and mounted by compose.
- OpenCode headless permissions are explicit per workspace through `opencode.json`; ask mode is not used by Gateway.
- Real Claude SDK execution is blocked until credentials are available in this process; the SDK package and driver integration are present.
