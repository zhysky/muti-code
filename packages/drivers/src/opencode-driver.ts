import type { AgentEvent, AgentHealth, AgentModel, AgentRunRequest } from "@agent-gateway/core";
import { BaseDriver, commandExists } from "./base.js";
import { MockAgentDriver } from "./mock-driver.js";

export class OpenCodeDriver extends BaseDriver {
  private readonly mock = new MockAgentDriver("opencode");
  private readonly remoteSessions = new Map<string, string>();

  constructor(private readonly driverMode = process.env.AGENT_DRIVER_MODE ?? "mock") {
    super("opencode", driverMode === "real" ? "http" : "mock");
  }

  async *start(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    if (this.driverMode !== "real") {
      yield* this.mock.start(request);
      return;
    }

    const controller = this.controllerFor(request.runId);
    const baseUrl = process.env.OPENCODE_BASE_URL ?? "http://localhost:4096";
    await fetch(`${baseUrl}/`).catch((error: unknown) => {
      throw new Error(`OpenCode server unavailable: ${error instanceof Error ? error.message : String(error)}`);
    });
    yield { type: "run.started", runId: request.runId };

    try {
      const model = parseOpenCodeModel(request.runtimeModel);
      const session = await openCodeFetch<{ id: string }>(baseUrl, "/session", {
        method: "POST",
        signal: controller.signal,
        searchParams: { directory: request.workspacePath },
        body: {
          title: `gateway-${request.runId}`,
          agent: "build",
          model: { providerID: model.providerID, id: model.modelID }
        }
      });
      this.remoteSessions.set(request.runId, session.id);

      const response = await openCodeFetch<OpenCodeMessageResponse>(baseUrl, `/session/${encodeURIComponent(session.id)}/message`, {
        method: "POST",
        signal: controller.signal,
        searchParams: { directory: request.workspacePath },
        body: {
          model,
          agent: "build",
          parts: [{ type: "text", text: request.prompt }]
        }
      });
      const error = response.info?.error;
      if (error) {
        yield { type: "run.failed", runId: request.runId, error: JSON.stringify(error) };
        return;
      }
      if (controller.signal.aborted) {
        yield { type: "run.aborted", runId: request.runId };
      } else {
        const text = extractOpenCodeText(response);
        if (text) {
          yield { type: "text.delta", runId: request.runId, text };
          yield { type: "message.completed", runId: request.runId, text };
        }
        yield { type: "run.completed", runId: request.runId, usage: response.info?.tokens };
      }
    } catch (error) {
      if (controller.signal.aborted) {
        yield { type: "run.aborted", runId: request.runId };
      } else {
        yield { type: "run.failed", runId: request.runId, error: error instanceof Error ? error.message : String(error) };
      }
    } finally {
      this.remoteSessions.delete(request.runId);
      this.cleanup(request.runId);
    }
  }

  override async abort(runId: string): Promise<void> {
    await super.abort(runId);
    const sessionId = this.remoteSessions.get(runId);
    if (!sessionId) return;
    const baseUrl = process.env.OPENCODE_BASE_URL ?? "http://localhost:4096";
    await openCodeFetch(baseUrl, `/session/${encodeURIComponent(sessionId)}/abort`, {
      method: "POST"
    }).catch(() => undefined);
  }

  async health(): Promise<AgentHealth> {
    const cli = await commandExists("opencode");
    let server = false;
    if (process.env.OPENCODE_BASE_URL) {
      server = await fetch(process.env.OPENCODE_BASE_URL).then(() => true, () => false);
    }
    return {
      ok: this.mode === "mock" || cli || server,
      mode: this.mode,
      details: {
        cli,
        server,
        baseUrl: process.env.OPENCODE_BASE_URL ?? "http://localhost:4096",
        headlessPermission: "WorkspaceManager writes explicit opencode.json and never relies on ask mode."
      }
    };
  }

  async listModels(): Promise<AgentModel[]> {
    return [
      { id: "opencode-claude", runtimeModel: "anthropic/claude-sonnet", displayName: "OpenCode + Claude", provider: "internal-opencode" },
      { id: "opencode-qwen", runtimeModel: "qwen/qwen3-coder", displayName: "OpenCode + Qwen", provider: "internal-opencode" },
      { id: "opencode-minimax-m3", runtimeModel: "minimaxi/MiniMax-M3", displayName: "OpenCode + MiniMax-M3", provider: "minimax-chat-completions" }
    ];
  }
}

interface OpenCodeMessageResponse {
  info?: {
    error?: unknown;
    tokens?: unknown;
  };
  parts?: Array<Record<string, unknown>>;
}

interface OpenCodeRequestOptions {
  method: "GET" | "POST";
  searchParams?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
}

function parseOpenCodeModel(runtimeModel: string): { providerID: string; modelID: string } {
  const [providerID, ...rest] = runtimeModel.split("/");
  const modelID = rest.join("/");
  if (!providerID || !modelID) {
    throw new Error(`Invalid OpenCode runtime model: ${runtimeModel}`);
  }
  return { providerID, modelID };
}

async function openCodeFetch<T = unknown>(baseUrl: string, path: string, options: OpenCodeRequestOptions): Promise<T> {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(options.searchParams ?? {})) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    method: options.method,
    signal: options.signal,
    headers: {
      ...openCodeAuthHeader(),
      ...(options.body === undefined ? {} : { "content-type": "application/json" })
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`OpenCode API ${options.method} ${path} failed (${response.status}): ${text || response.statusText}`);
  }
  if (!text) {
    return true as T;
  }
  return JSON.parse(text) as T;
}

function openCodeAuthHeader(): Record<string, string> {
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  if (!password) return {};
  const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
  return {
    authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
  };
}

function extractOpenCodeText(response: OpenCodeMessageResponse): string {
  const text = (response.parts ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text))
    .join("\n")
    .trim();
  return text.replace(/<think>[\s\S]*?<\/think>\s*/gi, "").trim();
}
