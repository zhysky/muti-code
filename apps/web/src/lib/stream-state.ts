import type { ChatMessage, TimelineEvent } from "../types.js";

const assistantStreamEventTypes = new Set<TimelineEvent["type"]>([
  "run.started",
  "text.delta",
  "message.completed",
  "tool.started",
  "tool.completed",
  "file.changed",
  "command.started",
  "command.completed",
  "run.failed",
  "run.aborted",
  "run.completed"
]);

export function shouldDisplayAssistantStreamEvent(event: TimelineEvent): boolean {
  return assistantStreamEventTypes.has(event.type);
}

export function createAssistantStreamMessage(runId: string): Required<Pick<ChatMessage, "id" | "role" | "content" | "runId" | "status" | "seenSeq">> & ChatMessage {
  return {
    id: `assistant-${runId}`,
    role: "assistant",
    content: "",
    runId,
    status: "streaming",
    seenSeq: new Set<number>()
  };
}

export function createPendingAssistantStreamMessage(id: string): ChatMessage {
  return {
    id,
    role: "assistant",
    content: "",
    runId: null,
    status: "streaming",
    seenSeq: new Set<number>()
  };
}

export function applyAssistantStreamEvent(message: ChatMessage, event: TimelineEvent): ChatMessage {
  if (message.runId && event.runId !== message.runId) return message;
  if (message.seenSeq?.has(event.seq)) return message;

  const seenSeq = new Set(message.seenSeq ?? []);
  seenSeq.add(event.seq);
  const next: ChatMessage = { ...message, seenSeq };

  if (event.type === "text.delta") {
    return {
      ...next,
      content: appendAssistantText(next.content, event.text),
      status: "streaming"
    };
  }

  if (event.type === "message.completed") {
    return {
      ...next,
      content: event.text,
      status: "completed"
    };
  }

  if (event.type === "run.failed") {
    return {
      ...next,
      status: "failed",
      error: event.error
    };
  }

  if (event.type === "run.aborted") {
    return {
      ...next,
      status: "aborted",
      error: "Run aborted"
    };
  }

  if (event.type === "run.completed") {
    return {
      ...next,
      status: next.status === "streaming" ? "completed" : next.status
    };
  }

  return next;
}

export function mergePersistedChatMessages(persisted: ChatMessage[], current: ChatMessage[]): ChatMessage[] {
  const currentByRun = new Map<string, ChatMessage>();
  for (const message of current) {
    if (message.role === "assistant" && message.runId) {
      currentByRun.set(message.runId, message);
    }
  }

  const persistedRunIds = new Set<string>();
  const merged = persisted.map((message) => {
    if (message.runId) persistedRunIds.add(message.runId);
    const currentMessage = message.runId ? currentByRun.get(message.runId) : undefined;
    if (!currentMessage?.error && currentMessage?.status !== "failed" && currentMessage?.status !== "aborted") {
      return message;
    }
    return {
      ...message,
      status: currentMessage.status,
      error: currentMessage.error
    };
  });

  const unpersistedTerminalDrafts = current.filter((message) => (
    message.role === "assistant"
    && Boolean(message.runId)
    && !persistedRunIds.has(message.runId ?? "")
    && (message.status === "failed" || message.status === "aborted")
    && Boolean(message.content || message.error)
  ));

  return [...merged, ...unpersistedTerminalDrafts];
}

function appendAssistantText(current: string, delta: string): string {
  if (!delta) return current;
  if (current && delta.startsWith(current)) return delta;
  if (delta.length >= 8 && current.endsWith(delta)) return current;
  return `${current}${delta}`;
}
