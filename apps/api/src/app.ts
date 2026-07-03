import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { z } from "zod";
import {
  AgentRouter,
  EventBus,
  ModelRouter,
  PermissionPolicy,
  RunService,
  Sanitizer,
  SessionService,
  WorkspaceManager,
  loadGatewayConfig
} from "@agent-gateway/core";
import type { AgentKind, PermissionProfile, Repository, SequencedAgentEvent } from "@agent-gateway/core";
import { createRepository, PostgresRepository } from "@agent-gateway/db";
import { ClaudeDriver, CodexDriver, OpenCodeDriver } from "@agent-gateway/drivers";
import { InternalIMAdapter, parseCommand } from "@agent-gateway/im";
import { requireApiToken, verifySignature } from "@agent-gateway/security";
import { logger } from "@agent-gateway/observability";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");

export interface AppServices {
  repo: Repository;
  sessionService: SessionService;
  runService: RunService;
  agentRouter: AgentRouter;
  modelRouter: ModelRouter;
  workspaceManager: WorkspaceManager;
  eventBus: EventBus;
  im: InternalIMAdapter;
}

export async function buildApp(overrides: Partial<AppServices> = {}) {
  const configDir = process.env.AGENT_CONFIG_DIR ?? path.join(repoRoot, "config");
  const workspaceRoot = process.env.WORKSPACE_ROOT ?? path.join(repoRoot, "workspaces");
  const sampleRoot = path.join(repoRoot, "sample-project");
  const snapshotRoot = path.join(repoRoot, "data", "workspace-snapshots");
  const gatewayConfig = await loadGatewayConfig(configDir);
  const repo = overrides.repo ?? createRepository(process.env.DATABASE_URL);
  if (repo instanceof PostgresRepository) {
    await migratePostgres(repo);
  }
  const workspaceManager = overrides.workspaceManager ?? new WorkspaceManager(workspaceRoot, sampleRoot, snapshotRoot);
  await workspaceManager.init();
  const modelRouter = overrides.modelRouter ?? new ModelRouter(gatewayConfig.models);
  const drivers = [
    new ClaudeDriver(),
    new CodexDriver(),
    new OpenCodeDriver()
  ];
  const agentRouter = overrides.agentRouter ?? new AgentRouter(gatewayConfig.agents, drivers, modelRouter);
  const permissionPolicy = new PermissionPolicy(gatewayConfig.permissions);
  const eventBus = overrides.eventBus ?? new EventBus({
    redisUrl: process.env.REDIS_URL,
    disabled: process.env.DEMO_STORAGE === "memory"
  });
  const sanitizer = new Sanitizer();
  const services = {
    repo,
    agentRouter,
    modelRouter,
    permissionPolicy,
    workspaceManager,
    eventBus,
    sanitizer
  };
  const sessionService = overrides.sessionService ?? new SessionService(services);
  const runService = overrides.runService ?? new RunService(services, sessionService);
  const im = overrides.im ?? new InternalIMAdapter();

  const app = Fastify({
    loggerInstance: logger
  });

  await app.register(cors, { origin: true });
  await app.register(swagger, {
    openapi: {
      info: {
        title: "Multi-Agent Gateway API",
        version: "0.1.0"
      }
    }
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });
  app.addHook("preHandler", async (request, reply) => {
    if (request.url === "/" || request.url === "/favicon.ico" || request.url.startsWith("/docs") || request.url === "/healthz" || request.url === "/readyz" || process.env.AUTH_DISABLED === "true") {
      return;
    }
    await requireApiToken(request, reply);
  });

  app.get("/", async (_request, reply) => {
    reply.type("text/html; charset=utf-8");
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Multi-Agent Gateway</title>
    <style>
      body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #18202a; background: #f5f7f8; }
      main { max-width: 760px; margin: 56px auto; padding: 0 24px; }
      h1 { font-size: 28px; margin: 0 0 12px; }
      p { color: #4f5f6b; line-height: 1.6; }
      .links { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 24px; }
      a { border: 1px solid #b9c6cf; border-radius: 8px; background: #fff; color: #174d68; padding: 10px 12px; text-decoration: none; }
      code { background: #e7edf1; border-radius: 4px; padding: 2px 5px; }
    </style>
  </head>
  <body>
    <main>
      <h1>Multi-Agent Gateway</h1>
      <p>The API is running on <code>:3000</code>. Open the Web demo on <code>:5173</code>, or inspect the Swagger API docs here.</p>
      <div class="links">
        <a href="http://localhost:5173/">Open Web Demo</a>
        <a href="/docs">Swagger Docs</a>
        <a href="/healthz">Health</a>
        <a href="/api/runtime">Runtime Status</a>
      </div>
    </main>
  </body>
</html>`;
  });

  app.get("/favicon.ico", async (_request, reply) => reply.code(204).send());

  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/readyz", async (_request, reply) => {
    try {
      await repo.ping();
      await eventBus.ping();
      await workspaceManager.list();
      return { status: "ready" };
    } catch (error) {
      return reply.code(503).send({ status: "not_ready", error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/metrics", async (_request, reply) => {
    const sessions = await repo.listSessions();
    reply.type("text/plain");
    return [
      "# HELP agent_gateway_sessions_total Active sessions.",
      "# TYPE agent_gateway_sessions_total gauge",
      `agent_gateway_sessions_total ${sessions.length}`
    ].join("\n");
  });

  app.get("/api/runtime", async () => ({
    driver_mode: process.env.AGENT_DRIVER_MODE ?? "mock",
    storage: process.env.DEMO_STORAGE === "memory" || !process.env.DATABASE_URL ? "memory" : "postgres",
    minimax_ready: Boolean(process.env.MINIMAX_API_KEY),
    anthropic_ready: Boolean(process.env.ANTHROPIC_API_KEY || process.env.MINIMAX_API_KEY),
    auth_disabled: process.env.AUTH_DISABLED === "true",
    opencode_base_url: process.env.OPENCODE_BASE_URL ?? "http://localhost:4096"
  }));


  app.get("/api/agents", async () => ({
    agents: agentRouter.list().map((agent) => ({
      id: agent.id,
      name: agent.name,
      default_model: agent.default_model,
      permission_profiles: agent.permission_profiles
    }))
  }));

  app.get("/api/agents/:agent/models", async (request) => {
    const params = z.object({ agent: z.enum(["claude", "codex", "opencode"]) }).parse(request.params);
    return { models: await agentRouter.models(params.agent) };
  });

  app.get("/api/agents/:agent/health", async (request) => {
    const params = z.object({ agent: z.enum(["claude", "codex", "opencode"]) }).parse(request.params);
    return agentRouter.getDriver(params.agent).health();
  });

  app.post("/api/sessions", async (request) => {
    const body = z.object({
      title: z.string().optional(),
      source: z.string().optional(),
      conversation_key: z.string().optional(),
      workspace_id: z.string().optional(),
      agent: z.enum(["claude", "codex", "opencode"]).optional(),
      model: z.string().optional(),
      permission_profile: permissionSchema.optional()
    }).parse(request.body ?? {});
    return sessionService.create(body);
  });

  app.get("/api/sessions", async () => ({ sessions: await repo.listSessions() }));

  app.get("/api/sessions/:session_id", async (request) => {
    const { session_id } = sessionParams.parse(request.params);
    return sessionService.requireSession(session_id);
  });

  app.post("/api/sessions/:session_id/agent", async (request) => {
    const { session_id } = sessionParams.parse(request.params);
    const body = z.object({
      agent: z.enum(["claude", "codex", "opencode"]),
      model: z.string()
    }).parse(request.body);
    return sessionService.switchAgent(session_id, body);
  });

  app.post("/api/sessions/:session_id/reset", async (request) => {
    const { session_id } = sessionParams.parse(request.params);
    return sessionService.reset(session_id);
  });

  app.delete("/api/sessions/:session_id", async (request) => {
    const { session_id } = sessionParams.parse(request.params);
    return sessionService.delete(session_id);
  });

  const messageBodySchema = z.object({
    content: z.string().min(1),
    agent: z.enum(["claude", "codex", "opencode"]).optional(),
    model: z.string().optional(),
    stream: z.boolean().optional(),
    permission_profile: permissionSchema.optional()
  });

  app.post("/api/sessions/:session_id/messages", async (request) => {
    const { session_id } = sessionParams.parse(request.params);
    const body = messageBodySchema.parse(request.body);
    const key = request.headers["idempotency-key"];
    return runService.sendMessage(session_id, body, Array.isArray(key) ? key[0] : key);
  });

  app.post("/api/sessions/:session_id/messages/stream", async (request, reply) => {
    const { session_id } = sessionParams.parse(request.params);
    const body = messageBodySchema.parse(request.body);
    const key = request.headers["idempotency-key"];
    const result = await runService.sendMessage(session_id, { ...body, stream: true }, Array.isArray(key) ? key[0] : key);
    await streamRunEvents(request, reply, repo, eventBus, result.run_id, {
      "x-message-id": result.message_id,
      "x-run-id": result.run_id,
      "x-stream-url": result.stream_url
    });
  });

  app.get("/api/sessions/:session_id/messages", async (request) => {
    const { session_id } = sessionParams.parse(request.params);
    await sessionService.requireSession(session_id);
    return { messages: await repo.listMessages(session_id) };
  });

  app.get("/api/runs/:run_id", async (request) => {
    const { run_id } = runParams.parse(request.params);
    return runService.requireRun(run_id);
  });

  app.post("/api/runs/:run_id/abort", async (request) => {
    const { run_id } = runParams.parse(request.params);
    return runService.abort(run_id);
  });

  app.get("/api/runs/:run_id/debug-events", async (_request, reply) => {
    return reply.code(403).send({
      error: "debug events are disabled in v1 because raw tool output must not be persisted by default"
    });
  });

  app.get("/api/runs/:run_id/events", async (request, reply) => {
    const { run_id } = runParams.parse(request.params);
    await runService.requireRun(run_id);
    await streamRunEvents(request, reply, repo, eventBus, run_id);
  });

  app.get("/api/workspaces", async () => ({ workspaces: await workspaceManager.list() }));

  app.post("/api/workspaces", async (request) => {
    const body = z.object({ id: z.string().min(1) }).parse(request.body);
    return workspaceManager.create(body.id);
  });

  app.get("/api/workspaces/:workspace_id/files", async (request) => {
    const { workspace_id } = workspaceParams.parse(request.params);
    return { files: await workspaceManager.listFiles(workspace_id) };
  });

  app.get("/api/workspaces/:workspace_id/diff", async (request) => {
    const { workspace_id } = workspaceParams.parse(request.params);
    return { diff: await workspaceManager.diff(workspace_id) };
  });

  app.post("/api/workspaces/:workspace_id/reset", async (request) => {
    const { workspace_id } = workspaceParams.parse(request.params);
    await workspaceManager.reset(workspace_id);
    return { status: "reset" };
  });

  app.post("/api/workspaces/:workspace_id/snapshot", async (request) => {
    const { workspace_id } = workspaceParams.parse(request.params);
    await workspaceManager.snapshot(workspace_id);
    return { status: "snapshotted" };
  });

  app.post("/api/im/internal/webhook", async (request, reply) => {
    const imSecret = process.env.INTERNAL_IM_SECRET;
    if (imSecret) {
      const signature = request.headers["x-gateway-signature"];
      const signatureValue = Array.isArray(signature) ? signature[0] : signature;
      if (!signatureValue || !verifySignature(JSON.stringify(request.body ?? {}), signatureValue, imSecret)) {
        return reply.code(401).send({ error: "invalid im signature" });
      }
    }
    if (!(await im.verify(request.body))) {
      return reply.code(401).send({ error: "invalid im request" });
    }
    const inbound = await im.parse(request.body);
    const dedupKey = `dedup:im:${inbound.source}:${inbound.sourceEventId}`;
    if (await repo.hasDedupKey(dedupKey)) {
      return { status: "duplicate" };
    }
    await repo.saveDedupKey(dedupKey, 24 * 60 * 60);
    const result = await handleIm(inbound.text, inbound.conversationKey);
    return result;
  });

  app.post("/api/im/feishu/webhook", async (_request) => ({
    status: "accepted",
    note: "Feishu adapter shares the IMAdapter contract; configure official verification before production."
  }));

  app.post("/api/im/wecom/webhook", async (_request) => ({
    status: "accepted",
    note: "WeCom adapter shares the IMAdapter contract; configure official verification before production."
  }));

  app.get("/api/quota/me", async () => ({
    default_user_daily_runs: gatewayConfig.quota?.default_user_daily_runs ?? 50,
    default_group_daily_runs: gatewayConfig.quota?.default_group_daily_runs ?? 200
  }));

  app.get("/api/quota/sessions/:session_id", async (request) => {
    const { session_id } = sessionParams.parse(request.params);
    await sessionService.requireSession(session_id);
    return { session_id, used: "demo", limit: gatewayConfig.quota?.default_user_daily_runs ?? 50 };
  });

  app.get("/api/admin/quota/usage", async () => ({ quota: gatewayConfig.quota ?? {} }));

  app.setErrorHandler((error, _request, reply) => {
    const typedError = error as Error & { statusCode?: number; code?: string };
    const statusCode = typedError.statusCode ?? 500;
    reply.code(statusCode).send({
      error: typedError.message,
      code: typedError.code ?? "ERROR"
    });
  });

  async function handleIm(text: string, conversationKey: string) {
    const command = parseCommand(text);
    let session = (await repo.listSessions()).find((item) => item.conversationKey === conversationKey);
    if (!session || command.type === "new") {
      session = await sessionService.create({
        title: `IM ${conversationKey}`,
        source: "im",
        conversation_key: conversationKey,
        agent: "claude",
        model: "claude-sonnet",
        workspace_id: "sample-project",
        permission_profile: "read-only"
      });
      if (command.type === "new") {
        return { status: "ok", session };
      }
    }
    if (command.type === "agent") {
      if (!command.value) return { status: "ok", text: `current agent: ${session.defaultAgent}` };
      const agent = z.enum(["claude", "codex", "opencode"]).parse(command.value);
      const model = modelRouter.defaultFor(agent, agentRouter.get(agent).default_model).id;
      session = await sessionService.switchAgent(session.id, { agent, model });
      return { status: "ok", text: `当前会话已切换到底层 Agent：${session.defaultAgent}` };
    }
    if (command.type === "model") {
      if (!command.value) return { status: "ok", text: `current model: ${session.defaultModel}` };
      modelRouter.requireModel(session.defaultAgent, command.value);
      session = await sessionService.switchAgent(session.id, { agent: session.defaultAgent, model: command.value });
      return { status: "ok", text: `当前模型：${session.defaultModel}` };
    }
    if (command.type === "reset") {
      await sessionService.reset(session.id);
      return { status: "ok", text: "session reset" };
    }
    if (command.type === "abort") {
      const activeRun = await runService.latestActiveRun(session.id);
      if (!activeRun) {
        return { status: "ok", text: "no active run to abort" };
      }
      const aborted = await runService.abort(activeRun.id);
      return { status: "ok", text: `aborted run ${aborted.id}`, run: aborted };
    }
    if (command.type === "status") {
      return { status: "ok", session };
    }
    if (command.type === "help") {
      return { status: "ok", commands: ["/agent", "/model", "/new", "/reset", "/abort", "/status", "/help"] };
    }
    const key = `im-${conversationKey}-${Date.now()}`;
    const result = await runService.sendMessage(session.id, { content: command.type === "message" ? command.value : text, stream: true }, key);
    const target = { conversationKey };
    await im.sendAck(target, `run ${result.run_id} started`);
    const unsubscribe = eventBus.subscribe(result.run_id, (item) => {
      void im.sendEvent(target, item.event);
      if (item.event.type === "message.completed") {
        void im.sendFinal(target, item.event.text);
      }
      if (["run.completed", "run.failed", "run.aborted"].includes(item.event.type)) {
        unsubscribe();
      }
    });
    for (const item of await replayEvents(repo, eventBus, result.run_id)) {
      void im.sendEvent(target, item.event);
      if (item.event.type === "message.completed") {
        void im.sendFinal(target, item.event.text);
      }
      if (["run.completed", "run.failed", "run.aborted"].includes(item.event.type)) {
        unsubscribe();
      }
    }
    return result;
  }

  const appServices: AppServices = {
    repo,
    sessionService,
    runService,
    agentRouter,
    modelRouter,
    workspaceManager,
    eventBus,
    im
  };

  return { app, services: appServices };
}

async function migratePostgres(repo: PostgresRepository): Promise<void> {
  const attempts = readPositiveInteger(process.env.DATABASE_MIGRATION_RETRIES, 30);
  const delayMs = readPositiveInteger(process.env.DATABASE_MIGRATION_RETRY_MS, 1000);
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await repo.migrate();
      return;
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      logger.warn({ err: error, attempt, attempts, retry_in_ms: delayMs }, "Postgres migration failed; retrying");
      await sleep(delayMs);
    }
  }

  throw lastError;
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function replayEvents(repo: Repository, eventBus: EventBus, runId: string): Promise<SequencedAgentEvent[]> {
  const busEvents = await eventBus.replay(runId);
  const durableEvents = (await repo.listRunEvents(runId)).map((event) => ({
    seq: event.seq,
    event: event.payload,
    createdAt: event.createdAt
  }));
  if (!busEvents.length) return durableEvents;
  const merged = new Map<number, SequencedAgentEvent>();
  for (const item of busEvents) merged.set(item.seq, item);
  for (const item of durableEvents) merged.set(item.seq, item);
  return [...merged.values()].sort((a, b) => a.seq - b.seq);
}

async function streamRunEvents(
  request: FastifyRequest,
  reply: FastifyReply,
  repo: Repository,
  eventBus: EventBus,
  runId: string,
  headers: Record<string, string> = {}
): Promise<void> {
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    ...headers
  });
  reply.raw.flushHeaders?.();
  reply.raw.write(": connected\n\n");

  let closed = false;
  const seen = new Set<number>();
  const heartbeat = setInterval(() => {
    if (!closed) reply.raw.write(": heartbeat\n\n");
  }, 15000);

  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    reply.raw.end();
  };

  const write = (item: SequencedAgentEvent) => {
    if (closed || seen.has(item.seq)) return;
    seen.add(item.seq);
    reply.raw.write(`event: ${item.event.type}\n`);
    reply.raw.write(`data: ${JSON.stringify({ seq: item.seq, created_at: item.createdAt, ...item.event })}\n\n`);
    if (isTerminalEvent(item.event.type)) {
      close();
    }
  };

  const unsubscribe = eventBus.subscribe(runId, write);
  request.raw.on("close", () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  });

  const replayed = await replayEvents(repo, eventBus, runId);
  for (const item of replayed) write(item);
}

function isTerminalEvent(type: string): boolean {
  return type === "run.completed" || type === "run.failed" || type === "run.aborted";
}

const permissionSchema = z.enum(["read-only", "workspace-write", "auto", "dangerous-admin"]) as z.ZodType<PermissionProfile>;
const sessionParams = z.object({ session_id: z.string().min(1) });
const runParams = z.object({ run_id: z.string().min(1) });
const workspaceParams = z.object({ workspace_id: z.string().min(1) });
