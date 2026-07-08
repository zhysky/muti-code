import { describe, expect, it } from "vitest";
import { applyAssistantStreamEvent, createAssistantStreamMessage, createPendingAssistantStreamMessage, mergePersistedChatMessages, shouldDisplayAssistantStreamEvent } from "../apps/web/src/lib/stream-state.js";
import type { ChatMessage, TimelineEvent } from "../apps/web/src/types.js";

describe("web assistant stream state", () => {
  it("creates a visible pending assistant bubble before the run id is known", () => {
    expect(createPendingAssistantStreamMessage("pending_1")).toMatchObject({
      id: "pending_1",
      role: "assistant",
      content: "",
      status: "streaming",
      runId: null
    });
  });

  it("shows an assistant stream bubble as soon as a run or activity starts", () => {
    expect(shouldDisplayAssistantStreamEvent(event(1, { type: "run.started", runId: "run_1" }))).toBe(true);
    expect(shouldDisplayAssistantStreamEvent(event(2, { type: "tool.started", runId: "run_1", tool: "web_fetch" }))).toBe(true);
    expect(shouldDisplayAssistantStreamEvent(event(3, { type: "command.started", runId: "run_1", command: "date" }))).toBe(true);
  });

  it("merges text deltas into one assistant message", () => {
    let message: ChatMessage = createAssistantStreamMessage("run_1");

    message = applyAssistantStreamEvent(message, event(1, { type: "text.delta", runId: "run_1", text: "hello " }));
    message = applyAssistantStreamEvent(message, event(2, { type: "text.delta", runId: "run_1", text: "world" }));

    expect(message.content).toBe("hello world");
    expect(message.status).toBe("streaming");
  });

  it("ignores full-text deltas that duplicate the current draft suffix", () => {
    let message: ChatMessage = createAssistantStreamMessage("run_1");

    message = applyAssistantStreamEvent(message, event(1, { type: "text.delta", runId: "run_1", text: "prefix: " }));
    message = applyAssistantStreamEvent(message, event(2, { type: "text.delta", runId: "run_1", text: "hello " }));
    message = applyAssistantStreamEvent(message, event(3, { type: "text.delta", runId: "run_1", text: "world" }));
    message = applyAssistantStreamEvent(message, event(4, { type: "text.delta", runId: "run_1", text: "hello world" }));

    expect(message.content).toBe("prefix: hello world");
  });

  it("ignores duplicate sequence numbers for the same run", () => {
    let message: ChatMessage = createAssistantStreamMessage("run_1");

    message = applyAssistantStreamEvent(message, event(1, { type: "text.delta", runId: "run_1", text: "hello" }));
    message = applyAssistantStreamEvent(message, event(1, { type: "text.delta", runId: "run_1", text: " duplicated" }));

    expect(message.content).toBe("hello");
    expect([...(message.seenSeq ?? [])]).toEqual([1]);
  });

  it("replaces draft deltas with the completed assistant message", () => {
    let message: ChatMessage = createAssistantStreamMessage("run_1");

    message = applyAssistantStreamEvent(message, event(1, { type: "text.delta", runId: "run_1", text: "partial" }));
    message = applyAssistantStreamEvent(message, event(2, { type: "message.completed", runId: "run_1", text: "final answer" }));

    expect(message.content).toBe("final answer");
    expect(message.status).toBe("completed");
  });

  it("supports completed-only streams", () => {
    const message = applyAssistantStreamEvent(
      createAssistantStreamMessage("run_1"),
      event(1, { type: "message.completed", runId: "run_1", text: "done" })
    );

    expect(message.content).toBe("done");
    expect(message.status).toBe("completed");
  });

  it("keeps the partial draft when a run fails", () => {
    let message: ChatMessage = createAssistantStreamMessage("run_1");

    message = applyAssistantStreamEvent(message, event(1, { type: "text.delta", runId: "run_1", text: "partial" }));
    message = applyAssistantStreamEvent(message, event(2, { type: "run.failed", runId: "run_1", error: "network failed" }));

    expect(message.content).toBe("partial");
    expect(message.status).toBe("failed");
    expect(message.error).toBe("network failed");
  });

  it("keeps failed stream drafts when persisted messages do not include an assistant response yet", () => {
    const persisted: ChatMessage[] = [{
      id: "msg_user",
      role: "user",
      content: "question",
      createdAt: "2026-07-03T10:00:00.000Z"
    }];
    const current: ChatMessage[] = [
      persisted[0],
      {
        id: "assistant-run_1",
        role: "assistant",
        runId: "run_1",
        content: "partial answer",
        status: "failed",
        error: "tool rejected",
        createdAt: "2026-07-03T10:00:01.000Z"
      }
    ];

    const merged = mergePersistedChatMessages(persisted, current);

    expect(merged).toHaveLength(2);
    expect(merged[1]).toMatchObject({
      role: "assistant",
      runId: "run_1",
      content: "partial answer",
      status: "failed",
      error: "tool rejected"
    });
  });

  it("preserves failed status when persisted assistant draft arrives after refresh", () => {
    const persisted: ChatMessage[] = [{
      id: "msg_assistant",
      role: "assistant",
      runId: "run_1",
      content: "partial answer",
      status: "completed"
    }];
    const current: ChatMessage[] = [{
      id: "assistant-run_1",
      role: "assistant",
      runId: "run_1",
      content: "partial answer",
      status: "failed",
      error: "Reached maximum number of turns"
    }];

    expect(mergePersistedChatMessages(persisted, current)[0]).toMatchObject({
      content: "partial answer",
      status: "failed",
      error: "Reached maximum number of turns"
    });
  });
});

function event(seq: number, payload: Record<string, unknown>): TimelineEvent {
  return { seq, ...payload } as TimelineEvent;
}
