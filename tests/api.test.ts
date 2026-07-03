import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../apps/api/src/app.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { makeTestServices, waitForRunDone } from "./helpers.js";
import { PostgresRepository } from "@agent-gateway/db";
import type { AgentDriver, AgentEvent, AgentHealth, AgentRunRequest, Repository } from "@agent-gateway/core";

describe("api integration", () => {
  let app: Awaited<ReturnType<typeof buildApp>>["app"];
  const savedMiniMaxApiKey = process.env.MINIMAX_API_KEY;

  beforeEach(async () => {
    process.env.DEMO_STORAGE = "memory";
    process.env.NODE_ENV = "demo";
    process.env.AUTH_DISABLED = "true";
    delete process.env.MINIMAX_API_KEY;
    const built = await buildApp();
    app = built.app;
    await app.ready();
  });

  afterEach(async () => {
    if (savedMiniMaxApiKey) {
      process.env.MINIMAX_API_KEY = savedMiniMaxApiKey;
    } else {
      delete process.env.MINIMAX_API_KEY;
    }
    delete process.env.DATABASE_MIGRATION_RETRIES;
    delete process.env.DATABASE_MIGRATION_RETRY_MS;
    await app.close();
  });

  it("replays completed run events over SSE and closes", async () => {
    const sessionResponse = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: {
        title: "sse",
        agent: "claude",
        model: "claude-sonnet",
        workspace_id: "sample-project",
        permission_profile: "read-only"
      }
    });
    const session = sessionResponse.json<{ id: string }>();
    const messageResponse = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/messages`,
      headers: { "Idempotency-Key": "sse-test-1" },
      payload: {
        content: "analyze project",
        agent: "claude",
        model: "claude-sonnet",
        stream: true
      }
    });
    const message = messageResponse.json<{ run_id: string }>();
    for (let attempt = 0; attempt < 100; attempt++) {
      const run = await app.inject({ method: "GET", url: `/api/runs/${message.run_id}` });
      if (run.json<{ status: string }>().status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const sse = await app.inject({ method: "GET", url: `/api/runs/${message.run_id}/events` });
    expect(sse.statusCode).toBe(200);
    expect(sse.payload).toContain("event: run.completed");
  });

  it("streams a message directly and flushes events before terminal completion", async () => {
    await app.close();
    const driver = new SlowStreamingDriver();
    const services = await makeTestServices([driver]);
    const built = await buildApp({
      repo: services.repo,
      sessionService: services.sessionService,
      runService: services.runService,
      agentRouter: services.agentRouter,
      modelRouter: services.modelRouter,
      workspaceManager: services.workspaceManager,
      eventBus: services.eventBus
    });
    app = built.app;
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind a port");
    const session = await services.sessionService.create({
      title: "direct stream",
      agent: "claude",
      model: "minimax-m3-claude",
      workspace_id: "sample-project",
      permission_profile: "read-only"
    });

    const response = await fetch(`http://127.0.0.1:${address.port}/api/sessions/${session.id}/messages/stream`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": "direct-stream-1"
      },
      body: JSON.stringify({
        content: "stream this",
        agent: "claude",
        model: "minimax-m3-claude",
        stream: true
      })
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("x-run-id")).toMatch(/^run_/);
    expect(response.headers.get("x-message-id")).toMatch(/^msg_/);
    expect(response.headers.get("x-stream-url")).toContain("/api/runs/");

    const reader = response.body?.getReader();
    if (!reader) throw new Error("response body is not readable");
    const firstChunk = await readUntil(reader, "\"text\":\"hello\"");
    expect(firstChunk).toContain("event: text.delta");
    expect(firstChunk).toContain("\"text\":\"hello\"");
    expect(firstChunk).not.toContain("run.completed");

    driver.finish();
    const rest = await readUntil(reader, "run.completed");
    expect(rest).toContain("event: message.completed");
    expect(rest).toContain("event: run.completed");
  });

  it("requires explicit auth disablement instead of bypassing all demo traffic", async () => {
    process.env.AUTH_DISABLED = "false";
    await app.close();
    const built = await buildApp();
    app = built.app;
    await app.ready();

    const unauthorized = await app.inject({ method: "GET", url: "/api/sessions" });
    expect(unauthorized.statusCode).toBe(401);
  });

  it("ships a preview proxy config with the web image", async () => {
    const repoRoot = path.resolve(new URL(".", import.meta.url).pathname, "..");
    const dockerfile = await readFile(path.join(repoRoot, "apps", "web", "Dockerfile"), "utf8");
    const previewConfig = await readFile(path.join(repoRoot, "apps", "web", "vite.preview.config.mjs"), "utf8");
    const compose = await readFile(path.join(repoRoot, "deploy", "docker-compose.yml"), "utf8");
    expect(dockerfile).toContain("vite.preview.config");
    expect(previewConfig).toContain("allowedHosts");
    expect(previewConfig).toContain("de.minakami-yuki.com");
    expect(compose).toContain("WEB_ALLOWED_HOSTS: ${WEB_ALLOWED_HOSTS:-de.minakami-yuki.com}");
  });

  it("shows a useful landing page at the API root", async () => {
    const response = await app.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.payload).toContain("Multi-Agent Gateway");
    expect(response.payload).toContain("/docs");
    expect(response.payload).toContain("http://localhost:5173");
  });

  it("reports demo runtime mode for the web shell", async () => {
    const response = await app.inject({ method: "GET", url: "/api/runtime" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      driver_mode: "mock",
      storage: "memory",
      minimax_ready: false
    });
  });

  it("renames default web sessions from the first user message", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: {
        title: "New chat",
        agent: "claude",
        model: "claude-sonnet",
        workspace_id: "sample-project",
        permission_profile: "read-only"
      }
    });
    const session = created.json<{ id: string }>();

    await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/messages`,
      payload: {
        content: "你可以做什么？",
        agent: "claude",
        model: "claude-sonnet"
      }
    });

    const updated = await app.inject({ method: "GET", url: `/api/sessions/${session.id}` });
    expect(updated.json<{ title: string }>().title).toBe("你可以做什么？");
  });

  it("does not 404 browser favicon requests", async () => {
    const response = await app.inject({ method: "GET", url: "/favicon.ico" });
    expect(response.statusCode).toBe(204);
  });

  it("retries postgres migration while the database is becoming ready", async () => {
    await app.close();
    process.env.DATABASE_MIGRATION_RETRIES = "2";
    process.env.DATABASE_MIGRATION_RETRY_MS = "1";
    let attempts = 0;
    const repo = Object.assign(Object.create(PostgresRepository.prototype), {
      migrate: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("postgres not ready");
      }),
      ping: vi.fn()
    }) as PostgresRepository & Repository;

    const built = await buildApp({ repo });
    app = built.app;
    await app.ready();

    expect(attempts).toBe(2);
  });

  it("aborts the latest active run from an IM conversation", async () => {
    await app.close();
    const driver = new AbortableImDriver();
    const services = await makeTestServices([driver]);
    const built = await buildApp({
      repo: services.repo,
      sessionService: services.sessionService,
      runService: services.runService,
      agentRouter: services.agentRouter,
      modelRouter: services.modelRouter,
      workspaceManager: services.workspaceManager,
      eventBus: services.eventBus
    });
    app = built.app;
    await app.ready();

    const start = await app.inject({
      method: "POST",
      url: "/api/im/internal/webhook",
      payload: {
        event_id: "evt-im-start",
        conversation_key: "im-abort",
        sender_key: "u1",
        text: "keep running until abort"
      }
    });
    const runId = start.json<{ run_id: string }>().run_id;
    await driver.waitStarted();

    const abort = await app.inject({
      method: "POST",
      url: "/api/im/internal/webhook",
      payload: {
        event_id: "evt-im-abort",
        conversation_key: "im-abort",
        sender_key: "u1",
        text: "/abort"
      }
    });
    expect(abort.json<{ text: string }>().text).toContain(runId);
    const run = await waitForRunDone(services, runId);
    expect(run.status).toBe("aborted");
  });
});

class AbortableImDriver implements AgentDriver {
  readonly kind = "claude" as const;
  private startedResolve?: () => void;
  private abortResolve?: () => void;
  private readonly started = new Promise<void>((resolve) => {
    this.startedResolve = resolve;
  });
  private readonly aborted = new Promise<void>((resolve) => {
    this.abortResolve = resolve;
  });

  async *start(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    yield { type: "run.started", runId: request.runId };
    this.startedResolve?.();
    await this.aborted;
    yield { type: "run.aborted", runId: request.runId };
  }

  async abort(): Promise<void> {
    this.abortResolve?.();
  }

  async health(): Promise<AgentHealth> {
    return { ok: true, mode: "mock" };
  }

  waitStarted(): Promise<void> {
    return this.started;
  }
}

class SlowStreamingDriver implements AgentDriver {
  readonly kind = "claude" as const;
  private finishRun?: () => void;
  private readonly finished = new Promise<void>((resolve) => {
    this.finishRun = resolve;
  });

  async *start(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    yield { type: "run.started", runId: request.runId };
    yield { type: "text.delta", runId: request.runId, text: "hello" };
    await this.finished;
    yield { type: "text.delta", runId: request.runId, text: " world" };
    yield { type: "message.completed", runId: request.runId, text: "hello world" };
    yield { type: "run.completed", runId: request.runId };
  }

  async abort(): Promise<void> {
    this.finish();
  }

  async health(): Promise<AgentHealth> {
    return { ok: true, mode: "mock" };
  }

  finish(): void {
    this.finishRun?.();
  }
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, marker: string): Promise<string> {
  const decoder = new TextDecoder();
  let result = "";
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${marker}`)), 1500))
    ]);
    if (chunk.done) break;
    result += decoder.decode(chunk.value, { stream: true });
    if (result.includes(marker)) return result;
  }
  throw new Error(`did not receive ${marker}; received: ${result}`);
}
