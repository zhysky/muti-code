import { describe, expect, it } from "vitest";
import {
  buildMessageStreamCurl,
  promptForRun,
  promptForRunDetails,
  runDiffFromEvents
} from "../apps/web/src/lib/run-details.js";
import type { ChatMessage, TimelineEvent } from "../apps/web/src/types.js";

describe("web run details", () => {
  it("shows only file diffs emitted by the selected run", () => {
    const events: TimelineEvent[] = [
      { seq: 1, type: "file.changed", runId: "run_old", path: "README.md", diff: "+old" },
      { seq: 2, type: "text.delta", runId: "run_current", text: "thinking" },
      { seq: 3, type: "file.changed", runId: "run_current", path: "AGENT_OUTPUT.md", diff: "+current" }
    ];

    expect(runDiffFromEvents(events, "run_current")).toBe("+current");
  });

  it("uses the user prompt that produced the selected run for curl examples", () => {
    const messages: ChatMessage[] = [
      { id: "user_1", role: "user", content: "旧问题" },
      { id: "assistant_1", role: "assistant", content: "旧回答", runId: "run_old" },
      { id: "user_2", role: "user", content: "当前问题" },
      { id: "assistant_2", role: "assistant", content: "当前回答", runId: "run_current" }
    ];

    expect(promptForRun(messages, "run_current")).toBe("当前问题");
  });

  it("does not fall back to an unrelated latest user prompt", () => {
    const messages: ChatMessage[] = [
      { id: "user_1", role: "user", content: "无关问题" },
      { id: "assistant_1", role: "assistant", content: "无关回答", runId: "run_other" }
    ];

    expect(promptForRunDetails(messages, {}, "run_current")).toBe("");
  });

  it("uses a prompt captured while the selected run is streaming", () => {
    expect(promptForRunDetails([], { run_current: "流式运行的问题" }, "run_current")).toBe("流式运行的问题");
  });

  it("builds a curl request with escaped json for the selected run prompt", () => {
    const curl = buildMessageStreamCurl({
      sessionId: "sess_1",
      agent: "claude",
      model: "minimax-m3",
      content: "查一下 MySQL \"对比\" Pg"
    });

    expect(curl).toContain("http://localhost:3000/api/sessions/sess_1/messages/stream");
    expect(curl).toContain("\"content\":\"查一下 MySQL \\\"对比\\\" Pg\"");
    expect(curl).not.toContain("帮我分析这个项目如何启动");
  });
});
