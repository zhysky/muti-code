import type { Agent, AgentKind, Message, Model, PermissionProfile, RuntimeStatus, RunRecord, Session, TimelineEvent } from "./types.js";

export interface StreamMessageInput {
  content: string;
  agent: AgentKind;
  model: string;
  permission_profile: PermissionProfile;
  stream?: boolean;
}

export interface StreamMeta {
  messageId: string;
  runId: string;
  streamUrl: string;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<T>;
}

async function requestSseEvents(url: string): Promise<{ events: TimelineEvent[] }> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(await response.text());
  const text = await response.text();
  return {
    events: text
      .split("\n\n")
      .map(parseSseBlock)
      .filter((event): event is TimelineEvent => Boolean(event))
  };
}

export const api = {
  getRuntime: () => requestJson<RuntimeStatus>("/api/runtime"),
  listAgents: () => requestJson<{ agents: Agent[] }>("/api/agents"),
  listModels: (agent: AgentKind) => requestJson<{ models: Model[] }>(`/api/agents/${agent}/models`),
  listSessions: () => requestJson<{ sessions: Session[] }>("/api/sessions"),
  getSession: (sessionId: string) => requestJson<Session>(`/api/sessions/${sessionId}`),
  createSession: (body: {
    title?: string;
    agent: AgentKind;
    model?: string;
    workspace_id: string;
    permission_profile: PermissionProfile;
  }) => requestJson<Session>("/api/sessions", jsonInit("POST", body)),
  switchAgent: (sessionId: string, body: { agent: AgentKind; model: string }) =>
    requestJson<Session>(`/api/sessions/${sessionId}/agent`, jsonInit("POST", body)),
  listMessages: (sessionId: string) => requestJson<{ messages: Message[] }>(`/api/sessions/${sessionId}/messages`),
  getRun: (runId: string) => requestJson<RunRecord>(`/api/runs/${runId}`),
  listRunEvents: (runId: string) => requestSseEvents(`/api/runs/${runId}/events`),
  abortRun: (runId: string) => requestJson<RunRecord>(`/api/runs/${runId}/abort`, jsonInit("POST")),
  getDiff: (workspaceId: string) => requestJson<{ diff: string }>(`/api/workspaces/${workspaceId}/diff`)
};

export async function streamMessage(
  sessionId: string,
  input: StreamMessageInput,
  onEvent: (event: TimelineEvent) => void
): Promise<StreamMeta> {
  const response = await fetch(`/api/sessions/${sessionId}/messages/stream`, {
    ...jsonInit("POST", { ...input, stream: true }),
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": `web-${sessionId}-${Date.now()}`
    }
  });
  if (!response.ok) throw new Error(await response.text());

  const meta: StreamMeta = {
    messageId: response.headers.get("x-message-id") ?? "",
    runId: response.headers.get("x-run-id") ?? "",
    streamUrl: response.headers.get("x-stream-url") ?? ""
  };
  if (!response.body) return meta;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const event = parseSseBlock(part);
      if (event) onEvent(event);
    }
  }

  const event = parseSseBlock(buffer);
  if (event) onEvent(event);
  return meta;
}

function jsonInit(method: "POST" | "PUT" | "PATCH" | "DELETE", body?: unknown): RequestInit {
  if (body === undefined) {
    return { method };
  }
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  };
}

function parseSseBlock(block: string): TimelineEvent | null {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return null;
  return JSON.parse(data) as TimelineEvent;
}
