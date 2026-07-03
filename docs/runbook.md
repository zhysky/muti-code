# 运行手册

## Phase 0

```bash
npm run phase0
```

查看 `docs/phase-0-runtime-check.md`。没有凭证时，真实 SDK/runtime 检查可能无法完成；mock driver 仍可用于演示和契约测试。

Phase 0 会检查 OpenCode `serve` 和显式 workspace 权限配置。real 模式下，driver 通过 HTTP API 访问 OpenCode server，不依赖 TUI 权限确认。

MiniMax-M3 运行时测试：

```bash
export MINIMAX_API_KEY=...
export INTERNAL_LLM_BASE_URL=https://api.minimaxi.com/v1
npm run phase0
```

## API

```bash
DEMO_STORAGE=memory NODE_ENV=demo npm run dev:api
```

不需要 Postgres/Redis 的本地 smoke test 可以使用 `DEMO_STORAGE=memory`。完整服务拓扑请使用 compose。

## Web

```bash
npm run dev:web
```

## Podman Compose

```bash
npm run compose:up
```

健康检查：

```bash
curl http://localhost:3000/api/runtime
curl http://localhost:3000/readyz
podman compose -f deploy/docker-compose.yml ps
```

## 远端部署

默认把 `origin/master` 部署到 `de.minakami-yuki.com:/opt/muti-code`，目标机使用 Docker Compose，并在 Nginx 上维护 `18443` TLS 反代入口：

```bash
bash scripts/deploy-remote.sh
```

常用覆盖项：

```bash
DEPLOY_REF=origin/my-branch PUBLIC_PORT=18443 bash scripts/deploy-remote.sh
```

## 权限配置

- `read-only`：Gateway 拒绝写入，driver 不应产生 `file.changed`。
- `workspace-write`：Gateway 获取 workspace lock，并允许在 workspace 内受控写入。
- `dangerous-admin`：已禁用。

## IM 内部 Webhook

```bash
curl -sS -X POST http://localhost:3000/api/im/internal/webhook \
  -H 'content-type: application/json' \
  -d '{"event_id":"evt-1","conversation_key":"demo","sender_key":"u1","text":"/agent codex"}'
```

支持的命令：`/agent`、`/model`、`/new`、`/reset`、`/abort`、`/status`、`/help`。
