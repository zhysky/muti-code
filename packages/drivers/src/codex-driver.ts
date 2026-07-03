import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AgentEvent, AgentHealth, AgentModel, AgentRunRequest, PermissionProfile } from "@agent-gateway/core";
import { BaseDriver, commandExists } from "./base.js";
import { MockAgentDriver } from "./mock-driver.js";

export class CodexDriver extends BaseDriver {
  private readonly mock = new MockAgentDriver("codex");

  constructor(private readonly driverMode = process.env.AGENT_DRIVER_MODE ?? "mock") {
    super("codex", driverMode === "real" ? "cli" : "mock");
  }

  async *start(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    await ensureCodexResponsesConfig(request.runtimeModel, request.permissionProfile);
    if (this.driverMode !== "real") {
      yield* this.mock.start(request);
      return;
    }
    if (shouldUseMiniMaxResponsesFallback(request.runtimeModel)) {
      yield* this.startMiniMaxResponses(request);
      return;
    }

    const controller = this.controllerFor(request.runId);
    yield { type: "run.started", runId: request.runId };
    const sandbox = request.permissionProfile === "workspace-write" ? "workspace-write" : "read-only";
    const args = ["exec", "--json", "--skip-git-repo-check", "-C", request.workspacePath, "-m", request.runtimeModel, "-s", sandbox, request.prompt];
    const child = spawn("codex", args, {
      cwd: request.workspacePath,
      env: {
        ...process.env,
        CODEX_HOME: process.env.CODEX_HOME ?? "./data/runtime/codex"
      },
      signal: controller.signal
    });
    const exit = waitForExit(child);
    let childError: unknown;
    let stderr = "";
    child.on("error", (error) => {
      childError = error;
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    try {
      for await (const chunk of child.stdout) {
        for (const line of String(chunk).split("\n").filter(Boolean)) {
          yield mapCodexJsonLine(request.runId, line);
        }
      }
      const exitCode = await exit;
      if (controller.signal.aborted) {
        yield { type: "run.aborted", runId: request.runId };
      } else if (exitCode === 0) {
        yield { type: "run.completed", runId: request.runId };
      } else {
        yield { type: "run.failed", runId: request.runId, error: childError instanceof Error ? childError.message : stderr.trim() || `codex exited with ${exitCode}` };
      }
    } finally {
      this.cleanup(request.runId);
    }
  }

  private async *startMiniMaxResponses(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    const controller = this.controllerFor(request.runId);
    yield { type: "run.started", runId: request.runId };
    try {
      const response = await fetch(`${miniMaxResponsesBaseUrl()}/responses`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${miniMaxResponsesApiKey()}`
        },
        body: JSON.stringify({
          model: request.runtimeModel,
          input: request.prompt
        })
      });
      const text = await response.text();
      if (!response.ok) {
        if (shouldUseMiniMaxChatFallback(response.status, text)) {
          yield* this.completeWithMiniMaxChatCompletions(request, controller);
          return;
        }
        yield { type: "run.failed", runId: request.runId, error: `MiniMax Responses API failed (${response.status}): ${text || response.statusText}` };
        return;
      }
      const parsed = JSON.parse(text) as ResponsesApiResponse;
      if (parsed.error) {
        const errorText = JSON.stringify(parsed.error);
        if (shouldUseMiniMaxChatFallback(undefined, errorText)) {
          yield* this.completeWithMiniMaxChatCompletions(request, controller);
          return;
        }
        yield { type: "run.failed", runId: request.runId, error: errorText };
        return;
      }
      if (controller.signal.aborted) {
        yield { type: "run.aborted", runId: request.runId };
        return;
      }
      const output = stripThinkBlocks(extractResponsesText(parsed));
      if (output) {
        yield { type: "text.delta", runId: request.runId, text: output };
        yield { type: "message.completed", runId: request.runId, text: output };
      }
      yield { type: "run.completed", runId: request.runId, usage: parsed.usage };
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

  private async *completeWithMiniMaxChatCompletions(
    request: AgentRunRequest,
    controller: AbortController
  ): AsyncIterable<AgentEvent> {
    const response = await fetch(`${miniMaxResponsesBaseUrl()}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${miniMaxResponsesApiKey()}`
      },
      body: JSON.stringify({
        model: request.runtimeModel,
        messages: [
          {
            role: "user",
            content: request.prompt
          }
        ]
      })
    });
    const text = await response.text();
    if (!response.ok) {
      if (shouldUseMiniMaxChatFallback(response.status, text)) {
        yield* this.completeWithMiniMaxAnthropicMessages(request, controller);
        return;
      }
      yield { type: "run.failed", runId: request.runId, error: `MiniMax Chat Completions API failed (${response.status}): ${text || response.statusText}` };
      return;
    }
    const parsed = JSON.parse(text) as ChatCompletionsApiResponse;
    if (parsed.error) {
      const errorText = JSON.stringify(parsed.error);
      if (shouldUseMiniMaxChatFallback(undefined, errorText)) {
        yield* this.completeWithMiniMaxAnthropicMessages(request, controller);
        return;
      }
      yield { type: "run.failed", runId: request.runId, error: errorText };
      return;
    }
    if (controller.signal.aborted) {
      yield { type: "run.aborted", runId: request.runId };
      return;
    }
    const output = stripThinkBlocks(extractChatCompletionsText(parsed));
    if (output) {
      yield { type: "text.delta", runId: request.runId, text: output };
      yield { type: "message.completed", runId: request.runId, text: output };
    }
    yield { type: "run.completed", runId: request.runId, usage: parsed.usage };
  }

  private async *completeWithMiniMaxAnthropicMessages(
    request: AgentRunRequest,
    controller: AbortController
  ): AsyncIterable<AgentEvent> {
    const response = await fetch(`${miniMaxAnthropicBaseUrl()}/v1/messages`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": miniMaxResponsesApiKey(),
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: request.runtimeModel,
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content: request.prompt
          }
        ]
      })
    });
    const text = await response.text();
    if (!response.ok) {
      yield { type: "run.failed", runId: request.runId, error: `MiniMax Anthropic Messages API failed (${response.status}): ${text || response.statusText}` };
      return;
    }
    const parsed = JSON.parse(text) as AnthropicMessagesApiResponse;
    if (parsed.error) {
      yield { type: "run.failed", runId: request.runId, error: JSON.stringify(parsed.error) };
      return;
    }
    if (controller.signal.aborted) {
      yield { type: "run.aborted", runId: request.runId };
      return;
    }
    const output = stripThinkBlocks(extractAnthropicMessagesText(parsed));
    if (output) {
      yield { type: "text.delta", runId: request.runId, text: output };
      yield { type: "message.completed", runId: request.runId, text: output };
    }
    yield { type: "run.completed", runId: request.runId, usage: parsed.usage };
  }

  async health(): Promise<AgentHealth> {
    const cli = await commandExists("codex");
    return {
      ok: this.mode === "mock" || cli,
      mode: this.mode,
      details: {
        cli,
        wireApi: "responses",
        codexHome: process.env.CODEX_HOME ?? "./data/runtime/codex"
      }
    };
  }

  async listModels(): Promise<AgentModel[]> {
    return [
      { id: "gpt-5-codex", runtimeModel: "gpt-5-codex", displayName: "GPT-5 Codex", provider: "internal-openai" },
      { id: "codex-qwen", runtimeModel: "qwen3-coder", displayName: "Codex + Qwen Coder", provider: "internal-codex-proxy" }
    ];
  }
}

export async function ensureCodexResponsesConfig(runtimeModel: string, profile: PermissionProfile): Promise<string> {
  const codexHome = process.env.CODEX_HOME ?? "./data/runtime/codex";
  await mkdir(codexHome, { recursive: true });
  const sandbox = profile === "workspace-write" ? "workspace-write" : "read-only";
  const envKey = process.env.MINIMAX_API_KEY ? "MINIMAX_API_KEY" : "INTERNAL_LLM_API_KEY";
  const baseUrl = process.env.INTERNAL_LLM_BASE_URL ?? (envKey === "MINIMAX_API_KEY" ? "https://api.minimaxi.com/v1" : "https://llm-gateway.example.com/v1");
  const config = `model = "${runtimeModel}"
model_provider = "internal_proxy"
sandbox_mode = "${sandbox}"
approval_policy = "on-request"

[model_providers.internal_proxy]
name = "Internal LLM Gateway"
base_url = "${baseUrl}"
env_key = "${envKey}"
wire_api = "responses"
`;
  const target = path.join(codexHome, "config.toml");
  await writeFile(target, config);
  return target;
}

function mapCodexJsonLine(runId: string, line: string): AgentEvent {
  try {
    const parsed = JSON.parse(line) as { msg?: string; type?: string; message?: string };
    const text = parsed.msg ?? parsed.message ?? JSON.stringify(parsed);
    return { type: "text.delta", runId, text };
  } catch {
    return { type: "text.delta", runId, text: line };
  }
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(child.exitCode);
  }
  return new Promise((resolve) => child.on("close", resolve));
}

interface ResponsesApiResponse {
  output_text?: string;
  output?: Array<{
    content?: Array<{
      text?: string;
    }>;
  }>;
  usage?: unknown;
  error?: unknown;
}

interface ChatCompletionsApiResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  usage?: unknown;
  error?: unknown;
}

interface AnthropicMessagesApiResponse {
  content?: Array<{
    type?: string;
    text?: string;
  }>;
  usage?: unknown;
  error?: unknown;
}

function shouldUseMiniMaxResponsesFallback(runtimeModel: string): boolean {
  return runtimeModel === "MiniMax-M3" && Boolean(process.env.MINIMAX_API_KEY);
}

function miniMaxResponsesBaseUrl(): string {
  return (process.env.INTERNAL_LLM_BASE_URL ?? "https://api.minimaxi.com/v1").replace(/\/$/, "");
}

function miniMaxAnthropicBaseUrl(): string {
  return (process.env.ANTHROPIC_BASE_URL ?? "https://api.minimaxi.com/anthropic").replace(/\/$/, "");
}

function miniMaxResponsesApiKey(): string {
  return process.env.MINIMAX_API_KEY || process.env.INTERNAL_LLM_API_KEY || "";
}

function shouldUseMiniMaxChatFallback(status: number | undefined, body: string): boolean {
  if (status === 429) return true;
  return body.includes("rate_limit_exceeded") || body.includes("速率限制");
}

function extractResponsesText(response: ResponsesApiResponse): string {
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }
  return (response.output ?? [])
    .flatMap((item) => item.content ?? [])
    .map((content) => content.text)
    .filter((text): text is string => typeof text === "string" && text.trim().length > 0)
    .join("\n")
    .trim();
}

function extractChatCompletionsText(response: ChatCompletionsApiResponse): string {
  return (response.choices ?? [])
    .map((choice) => choice.message?.content)
    .filter((text): text is string => typeof text === "string" && text.trim().length > 0)
    .join("\n")
    .trim();
}

function extractAnthropicMessagesText(response: AnthropicMessagesApiResponse): string {
  return (response.content ?? [])
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .filter((text): text is string => typeof text === "string" && text.trim().length > 0)
    .join("\n")
    .trim();
}

function stripThinkBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>\s*/gi, "").trim();
}
