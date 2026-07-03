# Multi-Agent Gateway

这是一个统一接入 Claude Code、Codex 和 OpenCode 的 Multi-Agent Gateway 演示 MVP。

未设置 `AGENT_DRIVER_MODE` 时，演示默认使用 mock driver。要使用真实模型，请先在当前 shell 中加载 `MINIMAX_API_KEY`，再用 `AGENT_DRIVER_MODE=real` 启动 Podman Compose 服务。

当前三个 agent 都已配置为默认使用 `MiniMax-M3`：

- Claude Code 默认模型：`minimax-m3-claude`
- Codex 默认模型：`minimax-m3-codex`
- OpenCode 默认模型：`opencode-minimax-m3`

演示中使用的 MiniMax 协议端点：

- Anthropic Messages：`https://api.minimaxi.com/anthropic/v1/messages`
- Chat Completions：`https://api.minimaxi.com/v1/chat/completions`
- Responses：`https://api.minimaxi.com/v1/responses`

## 真实模型快速启动

本地开发使用 Podman Compose。确认 shell 中已有 `MINIMAX_API_KEY` 后，启动完整服务栈：

```bash
source ~/.zshrc
npm run compose:up
```

打开：

- Web 演示：`http://localhost:5173/`
- API：`http://localhost:3000`
- Swagger：`http://localhost:3000/docs`

在 Web 演示中：

1. 选择 `Claude Code`、`Codex` 或 `OpenCode`。
2. 保持该 agent 的默认 MiniMax-M3 模型。
3. 输入消息并点击 `Send`。
4. 运行状态应显示 `Driver mode: real` 和 `minimax=ready`。

## 本地运行

如果只需要本地开发，不需要完整的 Postgres、Redis 和 OpenCode 拓扑，可以使用下面的方式：

```bash
npm install
npm run phase0
DEMO_STORAGE=memory NODE_ENV=demo AUTH_DISABLED=true npm run dev:api
npm run dev:web
```

打开：

- API：`http://localhost:3000`
- Swagger：`http://localhost:3000/docs`
- Web：`http://localhost:5173`

## 容器运行

完整演示拓扑使用 Podman Compose 启动，包含 `gateway`、`web`、`opencode`、`postgres` 和 `redis`。

```bash
source ~/.zshrc
npm run compose:up
```

### npm scripts 使用场景

| 命令 | 使用场景 |
| --- | --- |
| `npm run compose:up` | 第一次启动或正常启动真实模型演示服务。 |
| `npm run compose:down` | 停止并移除 compose 启动的服务容器。 |
| `npm run compose:restart` | 修改了公共代码、后端、前端或配置后，重建并强制重启全部服务。 |
| `npm run compose:restart:gateway` | 只修改了后端 API、core、db、drivers、im、security、observability 等 gateway 相关代码。 |
| `npm run compose:restart:web` | 只修改了前端 Web 代码。 |
| `npm run compose:up:safe` | 本机 Podman 拉取镜像或 credential helper 查询卡住时，用这个启动。 |
| `npm run compose:down:safe` | 使用 safe 模式启动后，用这个停止服务。 |
| `npm run compose:restart:safe` | 遇到 Podman credential helper 问题时，重建并强制重启全部服务。 |

常用检查命令：

```bash
curl http://localhost:3000/api/runtime
curl http://localhost:3000/readyz
podman compose -f deploy/docker-compose.yml ps
```

如果 Podman 拉取镜像或 credential helper 查询卡住，请优先使用带 `:safe` 后缀的脚本。

## HTTP 演示

```bash
BASE_URL=http://localhost:3000 bash scripts/demo-http.sh
```

## 运行时状态

Gateway 会把运行时状态持久化到容器临时磁盘之外：

- Claude：`data/runtime/claude` -> `/runtime/claude`
- Codex：`data/runtime/codex` -> `/runtime/codex`

Postgres 保存 Gateway 索引，例如 `runtime_session_id`；底层运行时 transcript/thread 文件保存在挂载的 runtime 目录中。

## Driver 模式

- `AGENT_DRIVER_MODE=mock`：无模型凭证的确定性本地演示模式。
- `AGENT_DRIVER_MODE=real`：调用真实 MiniMax-M3 端点。
  - Claude 使用 `@anthropic-ai/claude-agent-sdk` 和 MiniMax Anthropic Messages 兼容端点。
  - Codex 使用 MiniMax Responses API。
  - OpenCode 使用 `opencode serve` 和 MiniMax Chat Completions 兼容 provider。
- `AGENT_DRIVER_MODE=sdk`：用于定向运行时检查的 Claude SDK 模式。
- `AGENT_DRIVER_MODE=cli`：Claude 使用 CLI `stream-json` fallback。

`dangerous-admin` 模式已在配置和策略中禁用。
