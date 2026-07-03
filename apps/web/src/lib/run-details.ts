import type { AgentKind, ChatMessage, TimelineEvent } from "../types.js";

export function runDiffFromEvents(events: TimelineEvent[], runId: string | null): string {
  if (!runId) return "";
  return events
    .filter((event) => event.runId === runId && event.type === "file.changed")
    .map((event) => event.diff?.trim() || `Changed ${event.path}`)
    .join("\n\n");
}

export function promptForRun(messages: ChatMessage[], runId: string | null, fallback = ""): string {
  if (!runId) return fallback;
  const assistantIndex = messages.findIndex((message) => message.runId === runId && message.role !== "user");
  if (assistantIndex === -1) return fallback;

  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user" && message.content.trim()) return message.content;
  }
  return fallback;
}

export function promptForRunDetails(
  messages: ChatMessage[],
  runPrompts: Record<string, string>,
  runId: string | null
): string {
  if (!runId) return "";
  return runPrompts[runId] ?? promptForRun(messages, runId);
}

export function buildMessageStreamCurl(input: {
  sessionId: string;
  agent: AgentKind;
  model: string;
  content: string;
}): string {
  const payload = JSON.stringify({
    content: input.content,
    agent: input.agent,
    model: input.model,
    stream: true
  });
  return [
    `curl -N -X POST http://localhost:3000/api/sessions/${input.sessionId}/messages/stream \\`,
    "  -H 'content-type: application/json' \\",
    `  -H 'Idempotency-Key: web-${input.sessionId}-demo' \\`,
    `  -d '${shellSingleQuote(payload)}'`
  ].join("\n");
}

function shellSingleQuote(value: string): string {
  return value.replace(/'/g, "'\\''");
}
