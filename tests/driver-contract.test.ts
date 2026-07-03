import { describe, expect, it, vi } from "vitest";
import { ClaudeDriver, CodexDriver, OpenCodeDriver, claudeMaxTurns } from "@agent-gateway/drivers";
import type { AgentDriver, AgentEvent, AgentRunRequest } from "@agent-gateway/core";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("driver contract", () => {
  const drivers: AgentDriver[] = [
    new ClaudeDriver("mock"),
    new CodexDriver("mock"),
    new OpenCodeDriver("mock")
  ];

  it.each(drivers)("maps analysis run to unified AgentEvent for %s", async (driver) => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), `driver-${driver.kind}-`));
    const events = await collect(driver.start(request(driver.kind, workspacePath, "read-only", "analyze package.json")));
    expect(events[0]).toMatchObject({ type: "run.started" });
    expect(events.some((event) => event.type === "text.delta" || event.type === "message.completed")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "run.completed" });
  });

  it.each(drivers)("does not pretend mock mode can answer live weather for %s", async (driver) => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), `driver-weather-${driver.kind}-`));
    const events = await collect(driver.start(request(driver.kind, workspacePath, "read-only", "今天天气怎么样？")));
    const completed = events.find((event) => event.type === "message.completed");

    expect(completed).toMatchObject({
      type: "message.completed",
      text: expect.stringContaining("mock")
    });
    expect(completed).toMatchObject({
      type: "message.completed",
      text: expect.not.stringContaining("found a TypeScript demo project")
    });
  });

  it.each(drivers)("does not emit file.changed in read-only for %s", async (driver) => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), `driver-ro-${driver.kind}-`));
    const events = await collect(driver.start(request(driver.kind, workspacePath, "read-only", "create README file")));
    expect(events.some((event) => event.type === "file.changed")).toBe(false);
  });

  it.each(drivers)("emits file.changed in workspace-write for %s", async (driver) => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), `driver-write-${driver.kind}-`));
    const events = await collect(driver.start(request(driver.kind, workspacePath, "workspace-write", "create README file")));
    expect(events.some((event) => event.type === "file.changed")).toBe(true);
  });

  it("reports Claude real mode healthy when MiniMax Anthropic credentials are available", async () => {
    const previousMiniMaxKey = process.env.MINIMAX_API_KEY;
    process.env.MINIMAX_API_KEY = "test-key";

    try {
      const health = await new ClaudeDriver("real").health();

      expect(health).toMatchObject({
        ok: true,
        mode: "sdk",
        details: {
          customApiReady: true,
          anthropicBaseUrl: "https://api.minimaxi.com/anthropic"
        }
      });
    } finally {
      if (previousMiniMaxKey) {
        process.env.MINIMAX_API_KEY = previousMiniMaxKey;
      } else {
        delete process.env.MINIMAX_API_KEY;
      }
    }
  });

  it("falls back to MiniMax Chat Completions when Codex Responses is rate limited", async () => {
    const previousMiniMaxKey = process.env.MINIMAX_API_KEY;
    const previousCodexHome = process.env.CODEX_HOME;
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "driver-codex-minimax-"));
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "driver-codex-home-"));
    process.env.MINIMAX_API_KEY = "test-key";
    process.env.CODEX_HOME = codexHome;
    const fetchMock = vi.fn(async (url: string | URL) => {
      const target = String(url);
      if (target.endsWith("/responses")) {
        return new Response(JSON.stringify({
          error: {
            message: "rate limited",
            code: "rate_limit_exceeded"
          }
        }), { status: 429 });
      }
      if (target.endsWith("/chat/completions")) {
        return Response.json({
          choices: [
            {
              message: {
                content: "codex 部署验证通过"
              }
            }
          ],
          usage: {
            total_tokens: 8
          }
        });
      }
      throw new Error(`unexpected fetch url: ${target}`);
    });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof fetch;

    try {
      const events = await collect(new CodexDriver("real").start({
        ...request("codex", workspacePath, "read-only", "部署验证"),
        runtimeModel: "MiniMax-M3"
      }));

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0]?.[0]).toContain("/responses");
      expect(fetchMock.mock.calls[1]?.[0]).toContain("/chat/completions");
      expect(events).toContainEqual({
        type: "text.delta",
        runId: "run_codex",
        text: "codex 部署验证通过"
      });
      expect(events).toContainEqual({
        type: "message.completed",
        runId: "run_codex",
        text: "codex 部署验证通过"
      });
      expect(events.at(-1)).toMatchObject({ type: "run.completed" });
    } finally {
      globalThis.fetch = previousFetch;
      if (previousMiniMaxKey) {
        process.env.MINIMAX_API_KEY = previousMiniMaxKey;
      } else {
        delete process.env.MINIMAX_API_KEY;
      }
      if (previousCodexHome) {
        process.env.CODEX_HOME = previousCodexHome;
      } else {
        delete process.env.CODEX_HOME;
      }
    }
  });

  it("falls back to MiniMax Anthropic Messages when Codex Responses and Chat Completions are rate limited", async () => {
    const previousMiniMaxKey = process.env.MINIMAX_API_KEY;
    const previousCodexHome = process.env.CODEX_HOME;
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "driver-codex-minimax-anthropic-"));
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "driver-codex-home-"));
    process.env.MINIMAX_API_KEY = "test-key";
    process.env.CODEX_HOME = codexHome;
    const fetchMock = vi.fn(async (url: string | URL) => {
      const target = String(url);
      if (target.endsWith("/responses")) {
        return new Response(JSON.stringify({ error: { code: "rate_limit_exceeded" } }), { status: 429 });
      }
      if (target.endsWith("/chat/completions")) {
        return new Response(JSON.stringify({ error: { code: "rate_limit_exceeded" } }), { status: 429 });
      }
      if (target.endsWith("/v1/messages")) {
        return Response.json({
          content: [
            {
              type: "text",
              text: "codex Anthropic 兜底验证通过"
            }
          ],
          usage: {
            output_tokens: 7
          }
        });
      }
      throw new Error(`unexpected fetch url: ${target}`);
    });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof fetch;

    try {
      const events = await collect(new CodexDriver("real").start({
        ...request("codex", workspacePath, "read-only", "部署验证"),
        runtimeModel: "MiniMax-M3"
      }));

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(fetchMock.mock.calls[0]?.[0]).toContain("/responses");
      expect(fetchMock.mock.calls[1]?.[0]).toContain("/chat/completions");
      expect(fetchMock.mock.calls[2]?.[0]).toContain("/v1/messages");
      expect(events).toContainEqual({
        type: "message.completed",
        runId: "run_codex",
        text: "codex Anthropic 兜底验证通过"
      });
      expect(events.at(-1)).toMatchObject({ type: "run.completed" });
    } finally {
      globalThis.fetch = previousFetch;
      if (previousMiniMaxKey) {
        process.env.MINIMAX_API_KEY = previousMiniMaxKey;
      } else {
        delete process.env.MINIMAX_API_KEY;
      }
      if (previousCodexHome) {
        process.env.CODEX_HOME = previousCodexHome;
      } else {
        delete process.env.CODEX_HOME;
      }
    }
  });

  it("uses a higher default Claude SDK turn budget for web research runs", () => {
    expect(claudeMaxTurns()).toBeGreaterThanOrEqual(24);
  });

  it("allows overriding the Claude SDK turn budget", () => {
    const previous = process.env.CLAUDE_MAX_TURNS;
    process.env.CLAUDE_MAX_TURNS = "20";

    try {
      expect(claudeMaxTurns()).toBe(20);
    } finally {
      if (previous) {
        process.env.CLAUDE_MAX_TURNS = previous;
      } else {
        delete process.env.CLAUDE_MAX_TURNS;
      }
    }
  });
});

function request(
  agent: AgentRunRequest["agent"],
  workspacePath: string,
  permissionProfile: AgentRunRequest["permissionProfile"],
  prompt: string
): AgentRunRequest {
  return {
    runId: `run_${agent}`,
    sessionId: "sess_test",
    agent,
    model: agent === "codex" ? "gpt-5-codex" : agent === "opencode" ? "opencode-claude" : "claude-sonnet",
    runtimeModel: "demo-model",
    prompt,
    workspaceId: "sample-project",
    workspacePath,
    permissionProfile
  };
}

async function collect(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}
