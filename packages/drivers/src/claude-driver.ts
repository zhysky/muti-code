import { spawn } from "node:child_process";
import type { AgentEvent, AgentHealth, AgentModel, AgentRunRequest } from "@agent-gateway/core";
import { BaseDriver, commandExists } from "./base.js";
import { MockAgentDriver } from "./mock-driver.js";

export class ClaudeDriver extends BaseDriver {
  private readonly mock = new MockAgentDriver("claude");

  constructor(private readonly driverMode = process.env.AGENT_DRIVER_MODE ?? "mock") {
    super("claude", driverMode === "real" || driverMode === "sdk" ? "sdk" : driverMode === "cli" ? "cli" : "mock");
  }

  async *start(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    if (this.driverMode !== "real") {
      if (this.driverMode === "sdk") {
        yield* this.startSdk(request);
        return;
      }
      if (this.driverMode === "cli") {
        yield* this.startCli(request);
        return;
      }
      yield* this.mock.start(request);
      return;
    }
    yield* this.startSdk(request);
  }

  private async *startSdk(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    const controller = this.controllerFor(request.runId);
    yield { type: "run.started", runId: request.runId };
    try {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      let terminal = false;
      const response = query({
        prompt: request.prompt,
        options: {
          cwd: request.workspacePath,
          model: request.runtimeModel,
          abortController: controller,
          includePartialMessages: true,
          maxTurns: claudeMaxTurns(),
          permissionMode: request.permissionProfile === "workspace-write" ? "acceptEdits" : "dontAsk",
          allowedTools: claudeAllowedTools(request.permissionProfile),
          env: {
            ...process.env,
            ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || process.env.MINIMAX_API_KEY,
            ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL || (process.env.MINIMAX_API_KEY ? "https://api.minimaxi.com/anthropic" : undefined),
            CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? "./data/runtime/claude",
            CLAUDE_AGENT_SDK_CLIENT_APP: "multi-agent-gateway/0.1.0"
          }
        }
      });
      for await (const message of response) {
        for (const event of mapSdkMessage(request.runId, message)) {
          terminal ||= event.type === "run.completed" || event.type === "run.failed";
          yield event;
        }
      }
      if (!terminal && !controller.signal.aborted) {
        yield { type: "run.completed", runId: request.runId };
      }
      if (controller.signal.aborted) {
        yield { type: "run.aborted", runId: request.runId };
      }
    } catch (error) {
      if (controller.signal.aborted) {
        yield { type: "run.aborted", runId: request.runId };
      } else {
        yield { type: "run.failed", runId: request.runId, error: error instanceof Error ? error.message : String(error) };
      }
    } finally {
      this.cleanup(request.runId);
    }
  }

  private async *startCli(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    const controller = this.controllerFor(request.runId);
    yield { type: "run.started", runId: request.runId };
    const args = [
      "--bare",
      "-p",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--model",
      request.runtimeModel,
      request.prompt
    ];
    const child = spawn("claude", args, {
      cwd: request.workspacePath,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? "./data/runtime/claude"
      },
      signal: controller.signal
    });
    const exit = waitForExit(child);
    let childError: unknown;
    child.on("error", (error) => {
      childError = error;
    });

    try {
      for await (const chunk of child.stdout) {
        const text = String(chunk);
        for (const line of text.split("\n").filter(Boolean)) {
          yield { type: "text.delta", runId: request.runId, text: mapClaudeLine(line) };
        }
      }
      const exitCode = await exit;
      if (controller.signal.aborted) {
        yield { type: "run.aborted", runId: request.runId };
      } else if (exitCode === 0) {
        yield { type: "run.completed", runId: request.runId };
      } else {
        yield { type: "run.failed", runId: request.runId, error: childError instanceof Error ? childError.message : `claude exited with ${exitCode}` };
      }
    } finally {
      this.cleanup(request.runId);
    }
  }

  async health(): Promise<AgentHealth> {
    const cli = await commandExists("claude");
    const customApiReady = Boolean(process.env.ANTHROPIC_API_KEY || process.env.MINIMAX_API_KEY);
    return {
      ok: this.mode === "mock" || (this.mode === "sdk" ? customApiReady : cli),
      mode: this.mode,
      details: {
        cli,
        sdkPackage: "@anthropic-ai/claude-agent-sdk",
        customApiReady,
        anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || (process.env.MINIMAX_API_KEY ? "https://api.minimaxi.com/anthropic" : undefined),
        claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? "./data/runtime/claude"
      }
    };
  }

  async listModels(): Promise<AgentModel[]> {
    return [
      { id: "claude-sonnet", runtimeModel: "sonnet", displayName: "Claude Sonnet", provider: "internal-anthropic" }
      ,
      { id: "minimax-m3-claude", runtimeModel: "MiniMax-M3", displayName: "MiniMax-M3 via Anthropic Messages", provider: "minimax-anthropic" }
    ];
  }
}

export function claudeAllowedTools(profile: AgentRunRequest["permissionProfile"]): string[] {
  const readTools = ["Read", "Grep", "Glob", "Skill", "TaskCreate", "TaskUpdate", "WebFetch", "WebSearch"];
  if (profile === "workspace-write") {
    return [...readTools, "Edit", "Write", "MultiEdit", "Bash(npm test)", "Bash(pnpm test)", "Bash(git diff*)"];
  }
  return readTools;
}

export function claudeMaxTurns(): number {
  const value = Number(process.env.CLAUDE_MAX_TURNS);
  if (Number.isFinite(value) && value > 0) return Math.floor(value);
  return 32;
}

function mapSdkMessage(runId: string, message: unknown): AgentEvent[] {
  const item = message as {
    type?: string;
    subtype?: string;
    event?: { type?: string; delta?: { type?: string; text?: string } };
    message?: { content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }> };
    result?: string;
    errors?: string[];
    tool_name?: string;
    usage?: unknown;
  };
  if (item.type === "stream_event" && item.event?.type === "content_block_delta" && item.event.delta?.type === "text_delta" && item.event.delta.text) {
    return [{ type: "text.delta", runId, text: item.event.delta.text }];
  }
  if (item.type === "assistant" && item.message && typeof item.message === "object" && "content" in item.message) {
    const content = (item.message as { content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }> }).content ?? [];
    const events: AgentEvent[] = [];
    for (const block of content) {
      if (block.type === "text" && block.text) {
        events.push({ type: "text.delta", runId, text: block.text });
      }
      if (block.type === "tool_use" && block.name) {
        events.push({ type: "tool.started", runId, tool: block.name, input: block.input });
      }
    }
    return events;
  }
  if (item.type === "system" && item.subtype === "permission_denied") {
    return [{
      type: "tool.completed",
      runId,
      tool: item.tool_name ?? "permission",
      output: "permission denied"
    }];
  }
  if (item.type === "result") {
    if (item.subtype === "success") {
      return [
        { type: "message.completed", runId, text: item.result ?? "" },
        { type: "run.completed", runId, usage: item.usage }
      ];
    }
    return [{ type: "run.failed", runId, error: item.errors?.join("; ") || item.subtype || "Claude SDK error" }];
  }
  return [];
}

function mapClaudeLine(line: string): string {
  try {
    const parsed = JSON.parse(line) as { type?: string; delta?: { text?: string }; message?: { content?: unknown } };
    if (parsed.delta?.text) return parsed.delta.text;
    return JSON.stringify(parsed);
  } catch {
    return line;
  }
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(child.exitCode);
  }
  return new Promise((resolve) => child.on("close", resolve));
}
