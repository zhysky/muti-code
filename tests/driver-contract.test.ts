import { describe, expect, it } from "vitest";
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
