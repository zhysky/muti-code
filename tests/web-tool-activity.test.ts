import { describe, expect, it } from "vitest";
import {
  buildToolActivities,
  filterRunEvents,
  runEventSummary
} from "../apps/web/src/lib/tool-activity.js";
import type { TimelineEvent } from "../apps/web/src/types.js";

describe("web tool activity presentation", () => {
  it("aggregates consecutive WebFetch calls for the selected run", () => {
    const activities = buildToolActivities([
      event(1, { type: "tool.started", runId: "run_1", tool: "WebFetch" }),
      event(2, { type: "tool.started", runId: "run_1", tool: "WebFetch" }),
      event(3, { type: "tool.started", runId: "run_1", tool: "WebFetch" })
    ], "run_1");

    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      label: "网页抓取",
      name: "WebFetch",
      count: 3,
      status: "running",
      summary: "WebFetch x3"
    });
  });

  it("merges tool started and completed events into one completed activity", () => {
    const activities = buildToolActivities([
      event(1, { type: "tool.started", runId: "run_1", tool: "WebSearch", input: { query: "muse" } }),
      event(2, { type: "tool.completed", runId: "run_1", tool: "WebSearch", output: "10 results" })
    ], "run_1");

    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      label: "网页搜索",
      status: "completed",
      count: 1,
      summary: "10 results"
    });
    expect(activities[0].input).toEqual({ query: "muse" });
    expect(activities[0].output).toBe("10 results");
  });

  it("aggregates consecutive completed WebFetch calls even when they have input and output", () => {
    const activities = buildToolActivities([
      event(1, { type: "tool.started", runId: "run_1", tool: "WebFetch", input: { url: "https://a.example" } }),
      event(2, { type: "tool.completed", runId: "run_1", tool: "WebFetch", output: "A" }),
      event(3, { type: "tool.started", runId: "run_1", tool: "WebFetch", input: { url: "https://b.example" } }),
      event(4, { type: "tool.completed", runId: "run_1", tool: "WebFetch", output: "B" })
    ], "run_1");

    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      label: "网页抓取",
      name: "WebFetch",
      count: 2,
      status: "completed",
      summary: "WebFetch x2"
    });
    expect(activities[0].events).toHaveLength(4);
  });

  it("marks failed tool outputs and run failures as failed and expanded by default", () => {
    const activities = buildToolActivities([
      event(1, { type: "tool.completed", runId: "run_1", tool: "WebSearch", output: { error: "rate limited" } }),
      event(2, { type: "run.failed", runId: "run_1", error: "Reached maximum number of turns" })
    ], "run_1");

    expect(activities).toHaveLength(2);
    expect(activities[0]).toMatchObject({
      status: "failed",
      defaultOpen: true
    });
    expect(activities[1]).toMatchObject({
      kind: "error",
      label: "运行失败",
      status: "failed",
      defaultOpen: true
    });
  });

  it("does not include events from unrelated runs", () => {
    const activities = buildToolActivities([
      event(1, { type: "tool.started", runId: "run_old", tool: "WebFetch" }),
      event(2, { type: "tool.started", runId: "run_current", tool: "WebSearch" })
    ], "run_current");

    expect(activities).toHaveLength(1);
    expect(activities[0].name).toBe("WebSearch");
  });

  it("summarizes run events and filters drawer views", () => {
    const events = [
      event(1, { type: "tool.started", runId: "run_1", tool: "WebFetch" }),
      event(2, { type: "command.started", runId: "run_1", command: "npm test" }),
      event(3, { type: "file.changed", runId: "run_1", path: "README.md", diff: "+hello" }),
      event(4, { type: "run.failed", runId: "run_1", error: "failed" })
    ];

    expect(runEventSummary(events, "run_1")).toEqual({
      total: 4,
      tools: 1,
      commands: 1,
      files: 1,
      errors: 1
    });
    expect(filterRunEvents(events, "run_1", "tools").map((item) => item.type)).toEqual(["tool.started"]);
    expect(filterRunEvents(events, "run_1", "errors").map((item) => item.type)).toEqual(["run.failed"]);
  });

  it("keeps text events in the raw all filter but excludes them from step totals", () => {
    const events = [
      event(1, { type: "run.started", runId: "run_1" }),
      event(2, { type: "text.delta", runId: "run_1", text: "hello" }),
      event(3, { type: "tool.started", runId: "run_1", tool: "WebSearch" }),
      event(4, { type: "run.completed", runId: "run_1" })
    ];

    expect(filterRunEvents(events, "run_1", "all").map((item) => item.type)).toEqual([
      "run.started",
      "text.delta",
      "tool.started",
      "run.completed"
    ]);
    expect(runEventSummary(events, "run_1").total).toBe(1);
  });

  it("keeps standalone command completed events as output activity", () => {
    const activities = buildToolActivities([
      event(1, { type: "command.completed", runId: "run_1", exitCode: 1, output: "missing script" })
    ], "run_1");

    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      kind: "command",
      label: "命令输出",
      status: "failed",
      summary: "1: missing script",
      defaultOpen: true
    });
  });
});

function event(seq: number, payload: Record<string, unknown>): TimelineEvent {
  return { seq, ...payload } as TimelineEvent;
}
