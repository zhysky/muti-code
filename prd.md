# Multi-Agent Gateway PRD

## 1. 文档信息

| 项目       | 内容                                                      |
| -------- | ------------------------------------------------------- |
| 产品名称     | Multi-Agent Gateway                                     |
| 文档类型     | PRD                                                     |
| 目标读者     | Codex / 开发者 / 技术负责人 / 评审人                               |
| 当前阶段     | Demo MVP                                                |
| 交付形态     | 容器化 Web + HTTP API + IM Webhook + Multi-Agent Runtime   |
| 底层 Agent | Claude Code / Codex / OpenCode                          |
| 核心目标     | 用统一 Gateway 管理多种 coding agent 的调用、会话、模型、权限、事件、审计和 IM 接入 |

---

## 2. 背景

当前需要构建一个 demo：在容器环境中运行 coding agent，并通过浏览器、HTTP API、IM 与其交互。最初目标只要求 Claude Code / Claude Agent SDK，但后续扩展为同时支持：

* Claude Code / Claude Agent SDK；
* Codex；
* OpenCode。

新需求不是简单“包一层 CLI”，而是建设一个可切换底层 Agent 的统一网关：

```text
Browser / HTTP API / IM
        ↓
Multi-Agent Gateway
        ↓
Agent Driver Layer
        ├─ ClaudeDriver
        ├─ CodexDriver
        └─ OpenCodeDriver
```

Gateway 需要屏蔽三类 Agent 的差异，为上层提供一致的：

* Session API；
* Message API；
* Run API；
* Agent API；
* Model API；
* Workspace API；
* IM Webhook；
* SSE 流式输出；
* 权限控制；
* 审计日志；
* 事件追踪。

---

## 3. 产品目标

### 3.1 核心目标

建设一个可运行、可演示、可扩展的 Multi-Agent Gateway demo。

必须支持：

1. 浏览器中与 Agent 对话；
2. HTTP API 调用 Agent；
3. SSE 流式输出；
4. 切换底层 Agent；
5. 切换模型；
6. 保存会话历史；
7. 保存运行记录；
8. 管理 workspace；
9. 控制读写权限；
10. 支持任务中止；
11. 支持 IM webhook；
12. 记录工具调用、命令执行、文件变化；
13. 敏感信息入库前脱敏；
14. docker-compose 一键启动。

### 3.2 非目标

第一版不做：

1. 不做完整生产级多租户权限系统；
2. 不做复杂审批流；
3. 不做 ADK / LangGraph / CrewAI 等上层 Agent 框架；
4. 不做个人微信群机器人协议逆向；
5. 不直接接入真实生产代码仓库；
6. 不默认开放 full access；
7. 不允许前端传任意模型 ID；
8. 不把供应商 API key 下发到浏览器；
9. 不把未脱敏原始 tool output 存入数据库；
10. 不强行打通 Claude / Codex / OpenCode 的原生 session。

---

## 4. 用户角色

| 角色      | 说明                        | 核心诉求               |
| ------- | ------------------------- | ------------------ |
| Web 用户  | 通过浏览器使用 Agent             | 聊天、切换 Agent、查看结果   |
| API 调用方 | 通过 HTTP API 调用 Agent      | 稳定接口、幂等、流式输出       |
| IM 用户   | 在飞书 / 企业微信 / 内部 IM 中 @Bot | 快速提问、切换 Agent、接收结果 |
| 管理员     | 配置模型、权限、Agent、配额          | 管控风险、查看日志          |
| 开发者     | 实现和维护 Gateway             | 统一抽象、易扩展、可测试       |

---

## 5. 核心使用场景

### 5.1 浏览器使用 Agent

用户打开 Web UI，选择：

* Agent：Claude / Codex / OpenCode；
* Model：当前 Agent 下可用模型；
* Workspace：sample-project；
* Permission：read-only / workspace-write。

用户输入：

```text
帮我分析这个项目如何启动。
```

系统返回流式回答，并在右侧展示：

* 读取了哪些文件；
* 执行了哪些命令；
* 是否修改了文件；
* 当前 run 状态；
* 关联 run_id。

### 5.2 HTTP API 调用 Agent

调用方创建 session：

```http
POST /api/sessions
```

发送消息：

```http
POST /api/sessions/{session_id}/messages
```

然后通过：

```http
GET /api/runs/{run_id}/events
```

消费 SSE 流式事件。

### 5.3 IM 中调用 Agent

用户在群里发送：

```text
@Bot /agent codex
```

Bot 回复：

```text
当前会话已切换到底层 Agent：Codex
默认模型：gpt-5-codex
```

用户继续发送：

```text
@Bot 帮我分析这个报错
```

系统创建 run，处理后通过 IM 返回结果。

### 5.4 切换底层 Agent

同一个 Gateway session 中允许切换 Agent：

```text
turn 1: Claude
turn 2: Codex
turn 3: OpenCode
```

但三家原生 session 不强行共享。Gateway 自己维护 canonical history，并在切换 Agent 时生成接手摘要。

### 5.5 Workspace 写入

用户将 permission 从 `read-only` 切换为 `workspace-write`，要求 Agent 修改文件。

系统必须：

1. 获取 workspace 写锁；
2. 运行 Agent；
3. 记录 file.changed 事件；
4. 保存 diff；
5. run 结束后释放写锁；
6. abort / failed / timeout 时也必须释放写锁。

---

## 6. 总体架构

```text
┌──────────────────────────────────────────────┐
│ Clients                                      │
│ Browser UI / HTTP Caller / IM Bot            │
└───────────────────────┬──────────────────────┘
                        │
                        ▼
┌──────────────────────────────────────────────┐
│ Agent Gateway                                │
│ TypeScript + Fastify                         │
│ REST API / SSE / IM Webhook / OpenAPI        │
└───────────────────────┬──────────────────────┘
                        │
                        ▼
┌──────────────────────────────────────────────┐
│ Core Layer                                   │
│ AgentRouter / ModelRouter / SessionService   │
│ RunService / WorkspaceManager / EventBus      │
│ PermissionPolicy / Sanitizer / AuditLogger    │
└───────────────────────┬──────────────────────┘
                        │
        ┌───────────────┼────────────────┐
        ▼               ▼                ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ ClaudeDriver │ │ CodexDriver  │ │ OpenCodeDriver│
└──────┬───────┘ └──────┬───────┘ └──────┬───────┘
       ▼                ▼                ▼
Claude Agent SDK   Codex SDK/CLI    OpenCode Server
```

---

## 7. 技术选型

| 层级            | 选型                                                   |
| ------------- | ---------------------------------------------------- |
| 后端            | TypeScript / Node.js 20+                             |
| API 框架        | Fastify                                              |
| 类型校验          | Zod 或 TypeBox                                        |
| API 文档        | OpenAPI / Swagger                                    |
| 前端            | React + Vite                                         |
| 流式协议          | SSE                                                  |
| 数据库           | PostgreSQL                                           |
| 事件流 / 锁 / 去重  | Redis Streams + Redis Lock                           |
| Agent Runtime | Claude Agent SDK / Codex SDK or CLI / OpenCode serve |
| 部署            | Docker Compose                                       |
| 日志            | 结构化 JSON 日志                                          |
| 链路追踪          | OpenTelemetry 预留，run_id 必须贯穿                         |

说明：

* v1 选择 TypeScript 是因为首版采用单体 Gateway + Driver in-process 集成，三类 Agent 都有 TS 接入路径，开发效率最高；
* 生产阶段可将 runtime driver 拆成独立服务，语言可以解耦。

---

## 8. 产品范围

### 8.1 P0 必须实现

| 模块                  | 功能                                      |
| ------------------- | --------------------------------------- |
| Agent API           | 查询 Agent 列表、模型、健康状态                     |
| Session API         | 创建、查询、切换 Agent、重置、删除                    |
| Message API         | 发送消息、查询消息历史                             |
| Run API             | 查询 run、SSE 事件、中止 run                    |
| Workspace API       | 列表、文件、diff、reset、snapshot               |
| Driver Layer        | ClaudeDriver、CodexDriver、OpenCodeDriver |
| Event Layer         | 统一 AgentEvent                           |
| Permission          | read-only、workspace-write               |
| Storage             | Postgres 存 session/run/message/event    |
| Redis               | run events、lock、dedup                   |
| Web UI              | Chat、Agent 切换、模型切换、事件 timeline          |
| IM                  | internal webhook，至少预留飞书 / 企业微信接口        |
| Security            | API token、脱敏、危险权限默认关闭                   |
| Runtime Persistence | 持久化 Claude / Codex runtime 状态           |

### 8.2 P1 可选增强

| 模块            | 功能                     |
| ------------- | ---------------------- |
| IM            | 飞书真实接入                 |
| Quota         | 用户 / 群组 / workspace 限额 |
| Trace         | OpenTelemetry          |
| Admin UI      | 模型 / 配额 / 日志配置         |
| Runtime Split | Driver 独立服务化           |
| Approval      | 低风险自动执行，高风险审批          |

### 8.3 不进入 v1

| 功能              | 原因                                     |
| --------------- | -------------------------------------- |
| ADK / LangGraph | 当前目标是 Gateway，不是 workflow orchestrator |
| 个人微信机器人         | 合规和稳定性风险                               |
| 生产仓库写入          | demo 风险过高                              |
| full access     | 安全风险                                   |
| 多租户 RBAC        | 超出 demo 范围                             |

---

## 9. Agent 与模型设计

### 9.1 Agent 和 Model 分离

请求中必须分离：

```json
{
  "agent": "codex",
  "model": "gpt-5-codex"
}
```

禁止使用：

```json
{
  "model": "codex-gpt-5"
}
```

原因：

* 一个 Agent 可以支持多个模型；
* 一个模型可能通过不同 Agent 接入；
* Agent 切换和模型切换语义不同；
* 权限、session、runtime 配置都依赖 Agent 类型。

### 9.2 agents.yaml

```yaml
agents:
  - id: claude
    name: Claude Code
    driver: claude
    enabled: true
    default_model: claude-sonnet
    permission_profiles:
      - read-only
      - workspace-write

  - id: codex
    name: Codex
    driver: codex
    enabled: true
    default_model: gpt-5-codex
    permission_profiles:
      - read-only
      - workspace-write

  - id: opencode
    name: OpenCode
    driver: opencode
    enabled: true
    default_model: opencode-claude
    permission_profiles:
      - read-only
      - workspace-write
```

### 9.3 models.yaml

```yaml
models:
  - id: claude-sonnet
    agent: claude
    runtime_model: sonnet
    display_name: Claude Sonnet
    provider: internal-anthropic
    enabled: true

  - id: gpt-5-codex
    agent: codex
    runtime_model: gpt-5-codex
    display_name: GPT-5 Codex
    provider: internal-openai
    enabled: true

  - id: codex-qwen
    agent: codex
    runtime_model: qwen3-coder
    display_name: Codex + Qwen Coder
    provider: internal-codex-proxy
    enabled: true

  - id: opencode-claude
    agent: opencode
    runtime_model: anthropic/claude-sonnet
    display_name: OpenCode + Claude
    provider: internal-opencode
    enabled: true

  - id: opencode-qwen
    agent: opencode
    runtime_model: qwen/qwen3-coder
    display_name: OpenCode + Qwen
    provider: internal-opencode
    enabled: true
```

---

## 10. 统一 AgentEvent

不同 Agent 的原始事件必须统一转换为 `AgentEvent`。

```ts
export type AgentEvent =
  | { type: "run.started"; runId: string }
  | { type: "text.delta"; runId: string; text: string }
  | { type: "message.completed"; runId: string; text: string }
  | { type: "tool.started"; runId: string; tool: string; input?: unknown }
  | { type: "tool.completed"; runId: string; tool: string; output?: unknown }
  | { type: "file.changed"; runId: string; path: string; diff?: string }
  | { type: "command.started"; runId: string; command: string }
  | { type: "command.completed"; runId: string; exitCode: number; output?: string }
  | { type: "run.completed"; runId: string; usage?: unknown }
  | { type: "run.failed"; runId: string; error: string }
  | { type: "run.aborted"; runId: string };
```

要求：

1. Web UI 只消费 `AgentEvent`；
2. IM Adapter 只消费 `AgentEvent`；
3. SSE 只输出 `AgentEvent`；
4. 原始事件只允许进入 debug 逻辑，v1 默认不持久化 raw event；
5. 所有事件入库前必须脱敏。

---

## 11. Session 设计

### 11.1 Gateway Session

Gateway 维护统一 session：

```text
session_id = sess_xxx
```

Session 中记录：

* source；
* conversation_key；
* workspace_id；
* default_agent；
* default_model；
* permission_profile；
* summary；
* status；
* created_at；
* updated_at。

### 11.2 Runtime Session Binding

每个底层 Agent 各自维护 runtime session：

```text
sess_xxx
  ├─ claude_runtime_session_id
  ├─ codex_thread_id
  └─ opencode_session_id
```

不要尝试把三者原生 session 打通。

### 11.3 切换 Agent 的上下文接手

切换 Agent 时，Gateway 生成接手摘要：

```text
你正在接手一个已有任务。

历史摘要：
- 用户目标：xxx
- Claude 之前做了：xxx
- Codex 之前修改了：xxx
- OpenCode 之前观察到：xxx

当前 workspace 状态：
- modified files: xxx
- current diff summary: xxx

用户新请求：
xxx
```

---

## 12. Workspace 设计

### 12.1 Workspace 类型

| 类型                      | 说明               |
| ----------------------- | ---------------- |
| sample-project          | demo 项目          |
| session workspace       | 每个 session 的独立副本 |
| temporary run workspace | 可选，单 run 隔离      |

### 12.2 目录结构

```text
/workspaces
  /sample-project
  /sessions
    /sess_001
    /sess_002
/runtime
  /claude
  /codex
/data
/logs
/config
```

### 12.3 写锁规则

| 权限              | 行为              |
| --------------- | --------------- |
| read-only       | 可并发             |
| workspace-write | 同一 workspace 串行 |
| auto            | 同一 workspace 串行 |
| dangerous-admin | v1 禁用           |

不变量：

```text
只要 run 持有 workspace write lock，
无论 completed / failed / aborted / timeout，
最终都必须释放。
```

---

## 13. 权限策略

### 13.1 Permission Profile

```yaml
profiles:
  read-only:
    description: 只读分析，不允许写文件
    allow_write: false
    allow_shell: false
    allow_network: false

  workspace-write:
    description: 允许修改 workspace 内文件
    allow_write: true
    allow_shell: limited
    allow_network: false

  auto:
    description: 自动执行低风险操作
    allow_write: true
    allow_shell: limited
    allow_network: limited

  dangerous-admin:
    description: 高风险模式，默认禁用
    enabled: false
```

### 13.2 Driver 权限映射

| Gateway Profile | Claude           | Codex                      | OpenCode                      |
| --------------- | ---------------- | -------------------------- | ----------------------------- |
| read-only       | 只允许读工具           | read-only sandbox          | edit deny / bash deny         |
| workspace-write | 允许 workspace 内写入 | workspace-write sandbox    | edit allow / bash allowlist   |
| auto            | 低风险自动执行          | workspace-write + approval | explicit permission allowlist |
| dangerous-admin | v1 禁用            | v1 禁用                      | v1 禁用                         |

### 13.3 权限一致性验收

必须通过：

```text
read-only:
  - 尝试创建文件
  - 尝试修改文件
  - 尝试执行 shell
  - 三个 Driver 都必须拒绝或不产生副作用

workspace-write:
  - 允许修改 workspace 内文件
  - 禁止修改 workspace 外文件
  - 禁止危险命令
  - 禁止读取敏感文件

dangerous-admin:
  - v1 禁用
```

---

## 14. 三个 Driver 的特殊要求

### 14.1 ClaudeDriver

要求：

1. 使用 Claude Agent SDK TypeScript；
2. 支持自定义 `ANTHROPIC_BASE_URL`；
3. 支持 `ANTHROPIC_API_KEY`；
4. 支持 `CLAUDE_CONFIG_DIR`；
5. 支持指定 model；
6. 支持指定 cwd；
7. 支持 session resume；
8. 支持 abort；
9. 输出映射为 `AgentEvent`；
10. runtime session 必须可持久化。

docker-compose 中必须挂载：

```yaml
CLAUDE_CONFIG_DIR: /runtime/claude
volumes:
  - ./data/runtime/claude:/runtime/claude
```

### 14.2 CodexDriver

Codex 必须走 Responses API。

配置模板：

```toml
model = "gpt-5-codex"
model_provider = "internal_proxy"
sandbox_mode = "workspace-write"
approval_policy = "on-request"

[model_providers.internal_proxy]
name = "Internal LLM Gateway"
base_url = "https://llm-gateway.example.com/v1"
env_key = "INTERNAL_LLM_API_KEY"
wire_api = "responses"
```

要求：

1. 优先使用 Codex SDK；
2. SDK 不满足时使用 `codex exec --json` fallback；
3. internal provider 必须是 Responses API；
4. 必须持久化 `CODEX_HOME`；
5. 支持 read-only / workspace-write；
6. 支持 thread/session 恢复；
7. 支持 abort；
8. 输出映射为 `AgentEvent`。

docker-compose 中必须挂载：

```yaml
CODEX_HOME: /runtime/codex
volumes:
  - ./data/runtime/codex:/runtime/codex
```

### 14.3 OpenCodeDriver

接入方式：

```text
OpenCodeDriver
  -> opencode serve
  -> SDK / HTTP API
```

OpenCode headless 模式下，不能依赖 TUI 权限确认。

每个 workspace 必须生成明确的 `opencode.json`。

workspace-write 示例：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "edit": "allow",
    "bash": {
      "npm test": "allow",
      "pnpm test": "allow",
      "git diff*": "allow",
      "*": "deny"
    },
    "webfetch": "deny"
  }
}
```

验收要求：

1. OpenCodeDriver 在 workspace-write 下能真实写文件；
2. 不得因为等待权限确认而卡住；
3. read-only 下不得写文件；
4. OpenCode server 只在内网暴露；
5. 启用 `OPENCODE_SERVER_PASSWORD`。

---

## 15. HTTP API 需求

### 15.1 Agent API

#### GET /api/agents

返回可用 Agent。

响应示例：

```json
{
  "items": [
    {
      "id": "claude",
      "name": "Claude Code",
      "status": "healthy",
      "default_model": "claude-sonnet"
    },
    {
      "id": "codex",
      "name": "Codex",
      "status": "healthy",
      "default_model": "gpt-5-codex"
    },
    {
      "id": "opencode",
      "name": "OpenCode",
      "status": "healthy",
      "default_model": "opencode-claude"
    }
  ]
}
```

#### GET /api/agents/{agent}/models

返回某个 Agent 可用模型。

#### GET /api/agents/{agent}/health

返回 Driver 健康状态。

---

### 15.2 Session API

#### POST /api/sessions

创建 session。

请求：

```json
{
  "title": "demo session",
  "agent": "claude",
  "model": "claude-sonnet",
  "workspace_id": "sample-project",
  "permission_profile": "read-only"
}
```

响应：

```json
{
  "session_id": "sess_001",
  "status": "created"
}
```

#### GET /api/sessions

查询 session 列表。

#### GET /api/sessions/{session_id}

查询 session 详情。

#### POST /api/sessions/{session_id}/agent

切换默认 Agent。

请求：

```json
{
  "agent": "codex",
  "model": "gpt-5-codex"
}
```

#### POST /api/sessions/{session_id}/reset

重置 session。

#### DELETE /api/sessions/{session_id}

删除 session。

---

### 15.3 Message API

#### POST /api/sessions/{session_id}/messages

发送消息。

请求：

```json
{
  "content": "帮我分析这个项目的启动流程",
  "agent": "opencode",
  "model": "opencode-qwen",
  "stream": true
}
```

响应：

```json
{
  "message_id": "msg_001",
  "run_id": "run_001",
  "status": "running",
  "stream_url": "/api/runs/run_001/events"
}
```

幂等要求：

```http
Idempotency-Key: <client-generated-key>
```

语义：

| 场景                      | 行为              |
| ----------------------- | --------------- |
| 同 key + 同 request hash  | 返回第一次结果         |
| 同 key + 不同 request hash | 409 Conflict    |
| workspace-write 无 key   | 400 Bad Request |
| Web / IM                | 默认生成 key        |

#### GET /api/sessions/{session_id}/messages

查询消息历史。

---

### 15.4 Run API

#### GET /api/runs/{run_id}

查询 run 状态。

#### GET /api/runs/{run_id}/events

SSE 事件流。

示例：

```text
event: run.started
data: {"run_id":"run_001","agent":"codex"}

event: text.delta
data: {"seq":1,"text":"正在分析 package.json..."}

event: tool.started
data: {"seq":2,"tool":"read_file","input":{"path":"package.json"}}

event: run.completed
data: {"seq":3,"status":"completed"}
```

#### POST /api/runs/{run_id}/abort

中止任务。

要求：

1. run 状态进入 `aborting`；
2. 调用 driver abort；
3. 释放 workspace lock；
4. 发出 `run.aborted`；
5. 不得留下僵尸锁。

#### GET /api/runs/{run_id}/debug-events

debug 事件接口。v1 可返回脱敏后的 debug 信息，不返回 raw secret。

---

### 15.5 Workspace API

```http
GET  /api/workspaces
POST /api/workspaces
GET  /api/workspaces/{workspace_id}/files
GET  /api/workspaces/{workspace_id}/diff
POST /api/workspaces/{workspace_id}/reset
POST /api/workspaces/{workspace_id}/snapshot
```

---

### 15.6 IM API

```http
POST /api/im/internal/webhook
POST /api/im/feishu/webhook
POST /api/im/wecom/webhook
```

个人微信机器人不进入 v1 交付。

---

### 15.7 Health API

```http
GET /healthz
GET /readyz
GET /metrics
```

`/readyz` 必须检查：

* Postgres；
* Redis；
* config；
* workspace root；
* ClaudeDriver；
* CodexDriver；
* OpenCodeDriver；
* OpenCode server；
* runtime persistence path。

---

## 16. IM 需求

### 16.1 IMAdapter

```ts
export interface IMAdapter {
  kind: "feishu" | "wecom" | "internal";

  verify(request: unknown): Promise<boolean>;

  parse(request: unknown): Promise<IMInboundEvent>;

  sendAck(target: IMTarget, text: string): Promise<void>;

  sendEvent(target: IMTarget, event: AgentEvent): Promise<void>;

  sendFinal(target: IMTarget, text: string): Promise<void>;
}
```

### 16.2 IMInboundEvent

```ts
export interface IMInboundEvent {
  source: string;
  sourceEventId: string;
  conversationKey: string;
  senderKey: string;
  text: string;
  attachments: Attachment[];
  raw: unknown;
}
```

### 16.3 IM 命令

必须支持：

```text
/agent
/agent claude
/agent codex
/agent opencode
/model
/model gpt-5-codex
/new
/reset
/abort
/status
/help
```

### 16.4 IM 去重

所有 IM 入站事件必须使用：

```text
dedup:im:{source}:{event_id}
```

避免平台重试导致重复执行。

---

## 17. Web UI 需求

### 17.1 页面结构

```text
顶部栏：
  Agent 下拉
  Model 下拉
  Permission 下拉
  Workspace 下拉

左侧：
  Session 列表

中间：
  Chat 对话区
  输入框
  Abort 按钮

右侧：
  Event Timeline
  Tool 调用
  Command 执行
  File Change
  Diff 面板
  Debug 信息
```

### 17.2 必须功能

1. 创建 session；
2. 切换 Agent；
3. 切换模型；
4. 切换 permission profile；
5. 发送消息；
6. SSE 流式显示；
7. 展示 tool.started / tool.completed；
8. 展示 command.started / command.completed；
9. 展示 file.changed；
10. 查看 workspace diff；
11. abort run；
12. 展示 curl 示例；
13. 展示 run_id / session_id。

---

## 18. 数据库需求

使用 PostgreSQL。

### 18.1 表结构

必须包含：

* sessions；
* session_agent_bindings；
* messages；
* runs；
* run_events；
* im_bindings；
* audit_logs；
* idempotency_keys。

SQL 结构：

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  title TEXT,
  source TEXT NOT NULL,
  conversation_key TEXT,
  workspace_id TEXT NOT NULL,
  default_agent TEXT NOT NULL,
  default_model TEXT NOT NULL,
  permission_profile TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE session_agent_bindings (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  agent_kind TEXT NOT NULL,
  runtime_session_id TEXT,
  model TEXT,
  workspace_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE(session_id, agent_kind)
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  run_id TEXT,
  role TEXT NOT NULL,
  content TEXT,
  content_json JSONB,
  agent_kind TEXT,
  model TEXT,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  user_message_id TEXT,
  agent_kind TEXT NOT NULL,
  model TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  status TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  metadata JSONB
);

CREATE TABLE run_events (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  seq BIGINT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE(run_id, seq)
);

CREATE TABLE im_bindings (
  id TEXT PRIMARY KEY,
  im_type TEXT NOT NULL,
  im_conversation_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE(im_type, im_conversation_id)
);

CREATE TABLE audit_logs (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT,
  run_id TEXT,
  action TEXT NOT NULL,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE idempotency_keys (
  key TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json JSONB,
  run_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
```

---

## 19. Redis 需求

### 19.1 Key 设计

```text
stream:run:{run_id}:events
stream:im:{im_type}:outbound
lock:workspace:{workspace_id}
lock:session:{session_id}
dedup:im:{source}:{event_id}
active:runs
```

### 19.2 用途

| 用途               | Redis 结构                         |
| ---------------- | -------------------------------- |
| SSE 输出           | Redis Stream                     |
| Event replay     | Redis Stream + Postgres fallback |
| IM outbound      | Consumer group                   |
| event dedup      | SET NX EX                        |
| workspace lock   | SET NX EX                        |
| active run limit | counter / semaphore              |

---

## 20. 安全需求

### 20.1 API 鉴权

所有 `/api/*` 默认需要：

```http
Authorization: Bearer <AGENT_GATEWAY_TOKEN>
```

### 20.2 脱敏

脱敏必须发生在入库前：

```text
Agent raw event
  -> Sanitizer
  -> Safe AgentEvent
  -> Redis
  -> Postgres
  -> SSE / IM / Web
```

默认脱敏：

* `.env`；
* token；
* secret；
* private key；
* cookie；
* credential；
* SSH key；
* npmrc token；
* Authorization header；
* API key；
* metadata service 地址；
* 大段 shell output 中的疑似凭证。

### 20.3 审计

必须记录：

* run 创建；
* run 完成；
* run 失败；
* run 中止；
* tool 调用；
* command 执行；
* file change；
* permission deny；
* model 切换；
* agent 切换；
* IM 事件。

### 20.4 权限默认值

默认：

```text
read-only
```

禁用：

```text
dangerous-admin
```

---

## 21. 可观测性需求

所有日志必须带：

```text
trace_id
session_id
run_id
agent_kind
model
workspace_id
driver
provider
im_source
```

必须实现：

1. 结构化日志；
2. run_id 贯穿；
3. session_id 贯穿；
4. 错误码；
5. driver health；
6. `/metrics` 预留。

建议指标：

| 指标                          | 说明        |
| --------------------------- | --------- |
| runs_total                  | run 总数    |
| runs_failed_total           | 失败 run    |
| runs_aborted_total          | 中止 run    |
| run_duration_seconds        | run 时长    |
| active_runs                 | 当前运行数     |
| workspace_lock_wait_seconds | 写锁等待      |
| driver_errors_total         | Driver 错误 |
| im_events_total             | IM 入站     |
| sanitizer_redactions_total  | 脱敏次数      |
| quota_denied_total          | 配额拒绝      |

---

## 22. 配额需求

v1 做基础配额。

```yaml
quota:
  default_user_daily_runs: 50
  default_group_daily_runs: 200
  default_workspace_write_runs_per_day: 30
  expensive_models:
    - claude-opus
    - gpt-5-codex-max
```

预留 API：

```http
GET /api/quota/me
GET /api/quota/sessions/{session_id}
GET /api/admin/quota/usage
```

v1 最低要求：

1. 有配置文件；
2. RunService 可读取配置；
3. 超限返回 429；
4. 结构化日志记录 quota deny。

---

## 23. Docker Compose 需求

必须支持：

```bash
docker compose up
```

服务：

* gateway；
* web；
* opencode；
* postgres；
* redis。

gateway 必须配置：

```yaml
environment:
  NODE_ENV: demo
  DATABASE_URL: postgres://agent:agent@postgres:5432/agent
  REDIS_URL: redis://redis:6379
  AGENT_CONFIG_DIR: /config
  WORKSPACE_ROOT: /workspaces
  CLAUDE_CONFIG_DIR: /runtime/claude
  CODEX_HOME: /runtime/codex
  ANTHROPIC_BASE_URL: https://llm-gateway.example.com
  ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
  INTERNAL_LLM_API_KEY: ${INTERNAL_LLM_API_KEY}
  OPENCODE_BASE_URL: http://opencode:4096
  OPENCODE_SERVER_PASSWORD: demo-password
volumes:
  - ./config:/config
  - ./workspaces:/workspaces
  - ./data/runtime/claude:/runtime/claude
  - ./data/runtime/codex:/runtime/codex
  - ./data:/data
  - ./logs:/logs
```

OpenCode 服务：

```yaml
opencode:
  image: node:20
  working_dir: /app
  command: >
    sh -lc "npm install -g opencode-ai &&
            OPENCODE_SERVER_PASSWORD=demo-password
            opencode serve --hostname 0.0.0.0 --port 4096"
  environment:
    OPENCODE_SERVER_PASSWORD: demo-password
  volumes:
    - ./workspaces:/workspaces
    - ./data/opencode:/home/node/.config/opencode
```

---

## 24. 测试需求

### 24.1 必须测试

1. Driver contract test；
2. Permission profile consistency test；
3. Abort releases workspace lock test；
4. Runtime session persistence test；
5. SSE replay test；
6. IM event dedup test；
7. Sanitizer before DB insert test；
8. Idempotency-Key test；
9. OpenCode headless permission test；
10. Codex Responses API provider test；
11. Workspace write lock test；
12. ModelRouter validation test；
13. AgentRouter health check test。

### 24.2 Driver Contract Test

输入：

```text
分析 package.json
```

期望：

```text
run.started
至少一个 text.delta 或 message.completed
run.completed
```

输入：

```text
修改 README
```

期望：

```text
workspace-write 下产生 file.changed
read-only 下不产生 file.changed
```

---

## 25. 里程碑

### Phase 0：Runtime 可行性验证

交付：

* `docs/phase-0-runtime-check.md`；
* Claude runtime check；
* Codex Responses API provider check；
* OpenCode serve check；
* OpenCode workspace-write no-hang check；
* Claude/Codex local state persistence check；
* read-only / workspace-write 权限验证。

### Phase 1：Gateway 后端骨架

交付：

* Fastify API；
* PostgreSQL migrations；
* Redis connection；
* `/healthz`；
* `/readyz`；
* `/api/agents`；
* `/api/sessions`；
* `/api/sessions/{id}/messages`；
* `/api/runs/{id}/events`；
* Idempotency-Key；
* Sanitizer；
* Workspace lock；
* SSE 输出。

### Phase 2：三 Agent Driver

交付：

* AgentDriver interface；
* ClaudeDriver；
* CodexDriver；
* OpenCodeDriver；
* AgentRouter；
* ModelRouter；
* unified AgentEvent mapping；
* runtime session binding；
* abort；
* permission profile mapping；
* driver contract tests。

### Phase 3：Web UI

交付：

* React + Vite；
* Session list；
* Chat；
* Agent dropdown；
* Model dropdown；
* Permission dropdown；
* SSE rendering；
* Event timeline；
* Diff panel；
* Abort button；
* curl example panel。

### Phase 4：IM Adapter

交付：

* IMAdapter interface；
* internal webhook；
* 飞书或企业内部 IM adapter；
* event_id dedup；
* conversation -> session binding；
* `/agent`；
* `/model`；
* `/new`；
* `/abort`；
* IM 输出降级策略。

### Phase 5：Demo 包装

交付：

* docker-compose；
* sample-project；
* README；
* Swagger / OpenAPI；
* runbook；
* 演示脚本；
* 测试报告；
* 已知限制。

---

## 26. 验收标准

### 26.1 功能验收

| 功能             | 标准                             |
| -------------- | ------------------------------ |
| 浏览器聊天          | 能发送消息并流式显示                     |
| Agent 切换       | Claude / Codex / OpenCode 可切换  |
| 模型切换           | 每个 Agent 下可选模型                 |
| HTTP API       | curl 可调用，OpenAPI 可查看           |
| SSE            | run event 可流式消费                |
| IM             | internal webhook 跑通            |
| 中止任务           | abort 后状态正确                    |
| 会话恢复           | 刷新页面后历史仍在                      |
| 事件审计           | tool / command / file event 可查 |
| workspace diff | 可查看变更文件                        |

### 26.2 技术验收

| 项目                | 标准                                    |
| ----------------- | ------------------------------------- |
| Codex             | internal provider 通过 Responses API 跑通 |
| OpenCode          | workspace-write 写文件不等待 TUI 确认         |
| Claude / Codex 状态 | Gateway 容器重建后 runtime session 可恢复     |
| Abort             | workspace lock 必定释放                   |
| read-only         | 三个 Agent 都不能写文件                       |
| workspace-write   | 只能写 workspace 内文件                     |
| 幂等                | Message API 支持 Idempotency-Key        |
| 脱敏                | 入库前已脱敏                                |
| Redis             | Stream 中只保存脱敏后事件                      |
| docker-compose    | 一键启动                                  |
| 日志                | 包含 run_id / session_id / agent_kind   |
| 测试                | 有 Driver 契约测试和权限一致性测试                 |

---

## 27. 风险清单

| 风险                               | 影响               | 处理                                |
| -------------------------------- | ---------------- | --------------------------------- |
| Codex provider 不支持 Responses API | CodexDriver 无法联调 | Phase 0 前置验证                      |
| OpenCode 权限 ask 卡住               | run 静默超时         | 显式 permission config              |
| Claude/Codex 本地状态丢失              | session_id 悬空    | 挂载 CLAUDE_CONFIG_DIR / CODEX_HOME |
| 三家事件格式变化                         | UI / IM 失效       | AgentEvent mapper + contract test |
| 权限行为不一致                          | 安全边界失效           | 三 Driver 权限测试                     |
| Abort 后锁未释放                      | workspace 卡死     | finally 释放锁                       |
| 未脱敏数据入库                          | 审计库变敏感源          | 入库前 sanitizer                     |
| HTTP 重试重复执行                      | 重复改文件            | Idempotency-Key                   |
| 个人微信不稳定                          | 生产风险             | 不进 v1                             |
| 用量失控                             | 成本风险             | 配额配置                              |

---

## 28. Demo 演示脚本

### 28.1 浏览器演示

1. 打开 Web UI；
2. 创建 session；
3. 选择 Claude + read-only；
4. 输入：

```text
请分析 sample-project 的目录结构和启动方式。
```

5. 展示流式输出；
6. 切换 Agent 为 Codex；
7. 输入：

```text
请给这个项目补一份 README。
```

8. 切换 permission 为 workspace-write；
9. 展示 file.changed 和 diff；
10. 点击 Abort 演示中止；
11. 切换 OpenCode，执行一个只读分析；
12. 展示三种 Agent 使用同一套 API。

### 28.2 HTTP 演示

```bash
curl http://localhost:8080/api/agents \
  -H "Authorization: Bearer demo-token"
```

```bash
curl -X POST http://localhost:8080/api/sessions \
  -H "Authorization: Bearer demo-token" \
  -H "Content-Type: application/json" \
  -d '{"agent":"claude","model":"claude-sonnet","workspace_id":"sample-project","permission_profile":"read-only"}'
```

```bash
curl -N http://localhost:8080/api/runs/run_001/events \
  -H "Authorization: Bearer demo-token"
```

### 28.3 IM 演示

```text
@Bot /agent codex
```

```text
@Bot 帮我分析这个报错
```

---

## 29. Codex 实现注意事项

Codex 在实现本 PRD 时必须遵循：

1. 先检查仓库结构；
2. 不要删除已有业务代码；
3. 空仓库则初始化 monorepo；
4. 先做 Phase 0；
5. 每个 Phase 更新文档；
6. 配置文件提供 `.example`；
7. 不提交真实 token；
8. 危险权限默认关闭；
9. 所有事件入库前脱敏；
10. 所有 workspace-write message 必须有 Idempotency-Key；
11. 不跳过 Codex Responses API 验证；
12. 不跳过 OpenCode headless 权限验证；
13. 不跳过 Claude/Codex runtime persistence 验证；
14. 最后输出变更摘要、运行方式、验证命令、风险和未完成项。

---

## 30. 最终交付物

必须交付：

* 可运行代码；
* docker-compose；
* README；
* OpenAPI 文档；
* Phase 0 验证文档；
* 架构文档；
* 测试用例；
* sample-project；
* 演示脚本；
* 已知限制；
* 风险清单；
* 后续生产化建议。

---

## 31. 一句话总结

Multi-Agent Gateway 的价值不是把 Claude、Codex、OpenCode 各自包装一遍，而是用统一 Gateway 管理会话、模型、权限、workspace、事件、审计、IM 和 HTTP API。底层 Agent 可以替换，上层体验和接口保持一致。
