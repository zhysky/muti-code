import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { claudeAllowedTools, ensureCodexResponsesConfig } from "@agent-gateway/drivers";
import { EventBus, WorkspaceManager, redactUnknown, type AgentDriver, type AgentEvent, type AgentHealth, type AgentKind, type AgentRunRequest, type RunEventRecord } from "@agent-gateway/core";
import { makeTestServices, waitForRunDone } from "./helpers.js";

describe("gateway services", () => {
  it("rejects arbitrary model ids", async () => {
    const services = await makeTestServices();
    expect(() => services.modelRouter.requireModel("codex", "codex-gpt-5")).toThrow(/not enabled/);
  });

  it("returns health for every agent", async () => {
    const services = await makeTestServices();
    for (const agent of ["claude", "codex", "opencode"] as const) {
      const health = await services.agentRouter.getDriver(agent).health();
      expect(health.ok).toBe(true);
    }
  });

  it("injects weather web_fetch context before every agent driver", async () => {
    const models: Record<AgentKind, string> = {
      claude: "minimax-m3-claude",
      codex: "minimax-m3-codex",
      opencode: "opencode-minimax-m3"
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = weatherFetch as typeof fetch;

    try {
      for (const agent of ["claude", "codex", "opencode"] as const) {
        const driver = new PromptCaptureDriver(agent);
        const services = await makeTestServices([driver]);
        const session = await services.sessionService.create({
          agent,
          model: models[agent],
          permission_profile: "read-only"
        });
        const response = await services.runService.sendMessage(session.id, {
          content: "北京今天天气怎么样？",
          agent,
          model: models[agent],
          permission_profile: "read-only"
        }, `weather-${agent}`);

        await waitForRunDone(services, response.run_id);
        const events = await services.repo.listRunEvents(response.run_id);

        expect(driver.prompt).toContain("Gateway 已联网查询实时天气");
        expect(driver.prompt).toContain("用户原始请求");
        expect(events.some((event) => event.eventType === "tool.started" && event.payload.type === "tool.started" && event.payload.tool === "web_fetch")).toBe(true);
        expect(events.some((event) => event.eventType === "tool.completed" && event.payload.type === "tool.completed" && event.payload.tool === "web_fetch")).toBe(true);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("enforces Idempotency-Key semantics", async () => {
    const services = await makeTestServices();
    const session = await services.sessionService.create({
      agent: "codex",
      model: "gpt-5-codex",
      workspace_id: "sample-project",
      permission_profile: "workspace-write"
    });
    const first = await services.runService.sendMessage(session.id, {
      content: "create a file",
      agent: "codex",
      model: "gpt-5-codex",
      permission_profile: "workspace-write"
    }, "idem-1");
    const second = await services.runService.sendMessage(session.id, {
      content: "create a file",
      agent: "codex",
      model: "gpt-5-codex",
      permission_profile: "workspace-write"
    }, "idem-1");
    expect(second.run_id).toBe(first.run_id);
    await expect(services.runService.sendMessage(session.id, {
      content: "different request",
      agent: "codex",
      model: "gpt-5-codex",
      permission_profile: "workspace-write"
    }, "idem-1")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("ignores expired Idempotency-Key records", async () => {
    const services = await makeTestServices();
    const session = await services.sessionService.create({
      agent: "codex",
      model: "gpt-5-codex",
      workspace_id: "sample-project",
      permission_profile: "workspace-write"
    });
    await services.repo.saveIdempotency({
      key: "expired-key",
      scope: `messages:${session.id}`,
      requestHash: "old-request",
      responseJson: { run_id: "old" },
      runId: "old",
      createdAt: new Date(Date.now() - 2000).toISOString(),
      expiresAt: new Date(Date.now() - 1000).toISOString()
    });
    const response = await services.runService.sendMessage(session.id, {
      content: "create a file after expiry",
      agent: "codex",
      model: "gpt-5-codex",
      permission_profile: "workspace-write"
    }, "expired-key");
    expect(response.run_id).not.toBe("old");
  });

  it("requires Idempotency-Key for workspace-write", async () => {
    const services = await makeTestServices();
    const session = await services.sessionService.create({ agent: "claude", model: "claude-sonnet", permission_profile: "workspace-write" });
    await expect(services.runService.sendMessage(session.id, {
      content: "create file",
      permission_profile: "workspace-write"
    })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("redacts secret text without leaking original values", async () => {
    const privateKey = "-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----";
    const redacted = redactUnknown({
      type: "tool.completed",
      output: [
        `Authorization: Bearer abc123 token=secret-value ${privateKey}`,
        "registry=https://user:password@example.com/",
        "_authToken=npm_secret",
        "http://169.254.169.254/latest/meta-data"
      ].join("\n"),
      nested: { apiKey: "live_key", path: ".env.local" }
    });
    expect(JSON.stringify(redacted)).not.toContain("abc123");
    expect(JSON.stringify(redacted)).not.toContain("secret-value");
    expect(JSON.stringify(redacted)).not.toContain("live_key");
    expect(JSON.stringify(redacted)).not.toContain("npm_secret");
    expect(JSON.stringify(redacted)).not.toContain("169.254.169.254");
    expect(JSON.stringify(redacted)).not.toContain("PRIVATE KEY");
    expect(JSON.stringify(redacted)).toContain("[REDACTED]");
  });

  it("redacts cookie and password forms in command output", async () => {
    const redacted = redactUnknown({
      type: "command.completed",
      output: [
        "Cookie: sessionid=abc123; csrftoken=def456",
        "password=plain-secret",
        "db_password: another-secret"
      ].join("\n")
    });
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("abc123");
    expect(serialized).not.toContain("plain-secret");
    expect(serialized).not.toContain("another-secret");
    expect(serialized).toContain("[REDACTED]");
  });

  it("replays SSE events through event bus", async () => {
    const services = await makeTestServices();
    const session = await services.sessionService.create({ agent: "opencode", model: "opencode-claude" });
    const response = await services.runService.sendMessage(session.id, { content: "analyze", agent: "opencode", model: "opencode-claude" }, "ro-1");
    await waitForRunDone(services, response.run_id);
    const events = await services.eventBus.replay(response.run_id);
    expect(events.map((event) => event.event.type)).toContain("run.completed");
  });

  it("keeps in-memory events available when Redis publish fails", async () => {
    const bus = new EventBus({ redisUrl: "redis://127.0.0.1:1" });
    await expect(bus.publish({
      runId: "run_redis_down",
      seq: 1,
      eventType: "run.started",
      payload: { type: "run.started", runId: "run_redis_down" },
      event: { type: "run.started", runId: "run_redis_down" },
      createdAt: new Date().toISOString()
    })).resolves.toBeUndefined();
    expect((await bus.replay("run_redis_down")).map((event) => event.event.type)).toEqual(["run.started"]);
  });

  it("replays memory events missing from a partial Redis stream", async () => {
    const bus = new EventBus();
    const redisRows: Array<[string, string[]]> = [[
      "1-0",
      [
        "seq",
        "1",
        "event_type",
        "run.started",
        "payload",
        JSON.stringify({ type: "run.started", runId: "run_partial" }),
        "created_at",
        new Date(0).toISOString()
      ]
    ]];
    (bus as unknown as { redis: unknown }).redis = {
      status: "ready",
      connect: async () => undefined,
      xadd: async () => "2-0",
      xrange: async () => redisRows
    };
    await bus.publish({
      runId: "run_partial",
      seq: 2,
      eventType: "run.completed",
      payload: { type: "run.completed", runId: "run_partial" },
      event: { type: "run.completed", runId: "run_partial" },
      createdAt: new Date(1).toISOString()
    });
    expect((await bus.replay("run_partial")).map((event) => event.event.type)).toEqual(["run.started", "run.completed"]);
  });

  it("deduplicates IM events", async () => {
    const services = await makeTestServices();
    expect(await services.repo.hasDedupKey("dedup:im:internal:evt-1")).toBe(false);
    await services.repo.saveDedupKey("dedup:im:internal:evt-1", 60);
    expect(await services.repo.hasDedupKey("dedup:im:internal:evt-1")).toBe(true);
  });

  it("generates Codex Responses API provider config", async () => {
    const services = await makeTestServices();
    process.env.CODEX_HOME = path.join(services.temp, "codex-home");
    const configPath = await ensureCodexResponsesConfig("gpt-5-codex", "workspace-write");
    const config = await readFile(configPath, "utf8");
    expect(config).toContain('wire_api = "responses"');
    expect(config).not.toContain("chat_completions");
  });

  it("generates OpenCode headless permissions without ask mode", async () => {
    const services = await makeTestServices();
    const workspace = await services.workspaceManager.ensure("sample-project");
    await services.workspaceManager.writeOpenCodeConfig("sample-project", "workspace-write");
    const config = await readFile(path.join(workspace, "opencode.json"), "utf8");
    expect(config).toContain('"edit": "allow"');
    expect(config).toContain('"webfetch": "allow"');
    expect(config).toContain('"*": "deny"');
    expect(config).not.toContain('"ask"');
  });

  it("allows Claude research and planning tools in read-only and write modes", () => {
    expect(claudeAllowedTools("read-only")).toEqual(expect.arrayContaining(["Skill", "TaskCreate", "TaskUpdate", "WebFetch", "WebSearch"]));
    expect(claudeAllowedTools("workspace-write")).toEqual(expect.arrayContaining(["Skill", "TaskCreate", "TaskUpdate", "WebFetch", "WebSearch"]));
  });

  it("rejects path-special workspace ids", async () => {
    const services = await makeTestServices();
    await expect(services.workspaceManager.create(".")).rejects.toMatchObject({ code: "WORKSPACE_INVALID" });
    await expect(services.workspaceManager.create("..")).rejects.toMatchObject({ code: "WORKSPACE_INVALID" });
    await expect(services.workspaceManager.create("/tmp/x")).rejects.toMatchObject({ code: "WORKSPACE_INVALID" });
  });

  it("read-only workspace reads do not rewrite opencode permissions", async () => {
    const services = await makeTestServices();
    const workspace = await services.workspaceManager.ensure("sample-project");
    await services.workspaceManager.writeOpenCodeConfig("sample-project", "workspace-write");
    await services.workspaceManager.listFiles("sample-project");
    await services.workspaceManager.diff("sample-project");
    const config = await readFile(path.join(workspace, "opencode.json"), "utf8");
    expect(config).toContain('"edit": "allow"');
  });

  it("blocks reset and snapshot while workspace is locked", async () => {
    const services = await makeTestServices();
    const lock = await services.workspaceManager.acquireWriteLock("sample-project", "run_lock");
    await expect(services.workspaceManager.reset("sample-project")).rejects.toMatchObject({ code: "WORKSPACE_LOCKED" });
    await expect(services.workspaceManager.snapshot("sample-project")).rejects.toMatchObject({ code: "WORKSPACE_LOCKED" });
    lock.release();
  });

  it("persists runtime state directories for Claude and Codex", async () => {
    const services = await makeTestServices();
    process.env.CODEX_HOME = path.join(services.temp, "runtime", "codex");
    await ensureCodexResponsesConfig("gpt-5-codex", "read-only");
    const config = await readFile(path.join(process.env.CODEX_HOME, "config.toml"), "utf8");
    expect(config).toContain('wire_api = "responses"');
  });

  it("releases workspace lock after abort", async () => {
    const hangingDriver = new HangingClaudeDriver();
    const services = await makeTestServices([hangingDriver]);
    const session = await services.sessionService.create({
      agent: "claude",
      model: "claude-sonnet",
      permission_profile: "workspace-write"
    });
    const first = await services.runService.sendMessage(session.id, {
      content: "create a file slowly",
      agent: "claude",
      model: "claude-sonnet",
      permission_profile: "workspace-write"
    }, "abort-1");
    for (let attempt = 0; attempt < 500 && !services.workspaceManager.isLocked("sample-project"); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(services.workspaceManager.isLocked("sample-project")).toBe(true);
    await services.runService.abort(first.run_id);
    await waitForRunDone(services, first.run_id);
    expect(services.workspaceManager.isLocked("sample-project")).toBe(false);
    const second = await services.runService.sendMessage(session.id, {
      content: "create another file",
      agent: "claude",
      model: "claude-sonnet",
      permission_profile: "workspace-write"
    }, "abort-2");
    const done = await waitForRunDone(services, second.run_id);
    expect(done.status).toBe("completed");
  });

  it("abort publishes a terminal event and force releases non-cooperative locks", async () => {
    const hangingDriver = new NonCooperativeClaudeDriver();
    const services = await makeTestServices([hangingDriver]);
    const session = await services.sessionService.create({
      agent: "claude",
      model: "claude-sonnet",
      permission_profile: "workspace-write"
    });
    const run = await services.runService.sendMessage(session.id, {
      content: "create file and hang",
      agent: "claude",
      model: "claude-sonnet",
      permission_profile: "workspace-write"
    }, "abort-noncoop");
    for (let attempt = 0; attempt < 500 && !services.workspaceManager.isLocked("sample-project"); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const aborted = await services.runService.abort(run.run_id);
    const events = await services.repo.listRunEvents(run.run_id);
    expect(aborted.status).toBe("aborted");
    expect(services.workspaceManager.isLocked("sample-project")).toBe(false);
    expect(events.some((event) => event.eventType === "run.aborted")).toBe(true);
  });

  it("does not start a workspace-write driver after aborting before lock acquisition", async () => {
    const driver = new StartsAfterAbortDriver();
    const workspaceManager = new BlockingWorkspaceManager(
      path.join(await import("node:os").then((os) => os.tmpdir()), `agent-gateway-blocking-${Date.now()}`),
      path.resolve(new URL(".", import.meta.url).pathname, "..", "sample-project"),
      path.join(await import("node:os").then((os) => os.tmpdir()), `agent-gateway-blocking-snapshots-${Date.now()}`)
    );
    const services = await makeTestServices([driver], workspaceManager);
    const session = await services.sessionService.create({
      agent: "claude",
      model: "claude-sonnet",
      permission_profile: "workspace-write"
    });
    workspaceManager.blockNextLockAcquire();
    const run = await services.runService.sendMessage(session.id, {
      content: "create a file after an immediate abort",
      agent: "claude",
      model: "claude-sonnet",
      permission_profile: "workspace-write"
    }, "abort-before-lock");
    await Promise.race([
      workspaceManager.waitUntilBlocked(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("lock acquisition was not reached")), 500))
    ]);
    const aborted = await services.runService.abort(run.run_id);
    workspaceManager.releaseBlockedEnsure();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const finalRun = await services.repo.getRun(run.run_id);
    const events = await services.repo.listRunEvents(run.run_id);
    expect(aborted.status).toBe("aborted");
    expect(finalRun?.status).toBe("aborted");
    expect(driver.started).toBe(false);
    expect(services.workspaceManager.isLocked("sample-project")).toBe(false);
    expect(events.some((event) => event.eventType === "run.aborted")).toBe(true);
  });

  it("keeps read-only runs from changing workspace files", async () => {
    const services = await makeTestServices();
    const session = await services.sessionService.create({ agent: "codex", model: "gpt-5-codex", permission_profile: "read-only" });
    const response = await services.runService.sendMessage(session.id, {
      content: "create a file",
      agent: "codex",
      model: "gpt-5-codex",
      permission_profile: "read-only"
    }, "readonly-write");
    await waitForRunDone(services, response.run_id);
    const events = await services.repo.listRunEvents(response.run_id);
    expect(events.some((event) => event.eventType === "file.changed")).toBe(false);
  });

  it("persists assistant draft text when a run fails before message completion", async () => {
    const driver = new FailingAfterDraftDriver();
    const services = await makeTestServices([driver]);
    const session = await services.sessionService.create({
      agent: "claude",
      model: "claude-sonnet",
      permission_profile: "read-only"
    });
    const response = await services.runService.sendMessage(session.id, {
      content: "research with a tool failure",
      agent: "claude",
      model: "claude-sonnet",
      permission_profile: "read-only"
    }, "failed-draft");

    const done = await waitForRunDone(services, response.run_id);
    const messages = await services.repo.listMessages(session.id);
    const assistant = messages.find((message) => message.runId === response.run_id && message.role === "assistant");

    expect(done.status).toBe("failed");
    expect(assistant?.content).toBe("draft: partial answer before failure");
  });
});

class HangingClaudeDriver implements AgentDriver {
  readonly kind = "claude" as const;
  private releaseAbort?: () => void;
  private starts = 0;

  async *start(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    this.starts += 1;
    yield { type: "run.started", runId: request.runId };
    if (this.starts > 1) {
      yield { type: "message.completed", runId: request.runId, text: "second run completed" };
      yield { type: "run.completed", runId: request.runId };
      return;
    }
    await new Promise<void>((resolve) => {
      this.releaseAbort = resolve;
    });
    yield { type: "run.aborted", runId: request.runId };
  }

  async abort(): Promise<void> {
    this.releaseAbort?.();
  }

  async health(): Promise<AgentHealth> {
    return { ok: true, mode: "mock" };
  }
}

class NonCooperativeClaudeDriver implements AgentDriver {
  readonly kind = "claude" as const;

  async *start(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    yield { type: "run.started", runId: request.runId };
    await new Promise<void>(() => undefined);
  }

  async abort(): Promise<void> {}

  async health(): Promise<AgentHealth> {
    return { ok: true, mode: "mock" };
  }
}

class StartsAfterAbortDriver implements AgentDriver {
  readonly kind = "claude" as const;
  started = false;

  async *start(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    this.started = true;
    yield { type: "run.started", runId: request.runId };
    yield { type: "run.completed", runId: request.runId };
  }

  async abort(): Promise<void> {}

  async health(): Promise<AgentHealth> {
    return { ok: true, mode: "mock" };
  }
}

class PromptCaptureDriver implements AgentDriver {
  prompt = "";

  constructor(readonly kind: AgentKind) {}

  async *start(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    this.prompt = request.prompt;
    yield { type: "run.started", runId: request.runId };
    yield { type: "message.completed", runId: request.runId, text: "weather answer" };
    yield { type: "run.completed", runId: request.runId };
  }

  async abort(): Promise<void> {}

  async health(): Promise<AgentHealth> {
    return { ok: true, mode: "mock" };
  }
}

class FailingAfterDraftDriver implements AgentDriver {
  readonly kind = "claude" as const;

  async *start(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    yield { type: "run.started", runId: request.runId };
    yield { type: "text.delta", runId: request.runId, text: "draft: " };
    yield { type: "text.delta", runId: request.runId, text: "partial answer before " };
    yield { type: "text.delta", runId: request.runId, text: "failure" };
    yield { type: "text.delta", runId: request.runId, text: "partial answer before failure" };
    yield { type: "run.failed", runId: request.runId, error: "tool rejected" };
  }

  async abort(): Promise<void> {}

  async health(): Promise<AgentHealth> {
    return { ok: true, mode: "mock" };
  }
}

async function weatherFetch(input: string | URL): Promise<Response> {
  const url = String(input);
  if (url.includes("geocoding-api")) {
    return jsonResponse({
      results: [{
        name: "北京",
        country: "中国",
        admin1: "北京市",
        latitude: 39.9042,
        longitude: 116.4074
      }]
    });
  }
  return jsonResponse({
    timezone: "Asia/Shanghai",
    current: {
      time: "2026-07-03T16:00",
      temperature_2m: 30,
      apparent_temperature: 33,
      relative_humidity_2m: 62,
      precipitation: 0,
      weather_code: 1,
      wind_speed_10m: 8
    },
    daily: {
      weather_code: [1],
      temperature_2m_max: [33],
      temperature_2m_min: [24],
      precipitation_probability_max: [20]
    }
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

class BlockingWorkspaceManager extends WorkspaceManager {
  private blockedResolve?: () => void;
  private releaseResolve?: () => void;
  private readonly blocked = new Promise<void>((resolve) => {
    this.blockedResolve = resolve;
  });
  private readonly released = new Promise<void>((resolve) => {
    this.releaseResolve = resolve;
  });
  private blockNextLock = false;

  waitUntilBlocked(): Promise<void> {
    return this.blocked;
  }

  releaseBlockedEnsure(): void {
    this.releaseResolve?.();
  }

  blockNextLockAcquire(): void {
    this.blockNextLock = true;
  }

  override async acquireWriteLock(workspaceId: string, runId: string): Promise<{ runId: string; release: () => void }> {
    if (this.blockNextLock) {
      this.blockNextLock = false;
      this.blockedResolve?.();
      await this.released;
    }
    return super.acquireWriteLock(workspaceId, runId);
  }
}
