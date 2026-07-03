import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunDrawer } from "../apps/web/src/components/RunDrawer.js";
import { ToolActivityList } from "../apps/web/src/components/ToolActivityList.js";
import { buildToolActivities } from "../apps/web/src/lib/tool-activity.js";
import type { TimelineEvent } from "../apps/web/src/types.js";

describe("web tool activity rendering", () => {
  it("renders compact inline aggregated tool cards", () => {
    const activities = buildToolActivities([
      event(1, { type: "tool.started", runId: "run_1", tool: "WebFetch" }),
      event(2, { type: "tool.started", runId: "run_1", tool: "WebFetch" }),
      event(3, { type: "tool.started", runId: "run_1", tool: "WebFetch" })
    ], "run_1");

    const html = renderToStaticMarkup(React.createElement(ToolActivityList, {
      activities,
      runId: "run_1",
      onOpenRunDetails: () => undefined
    }));

    expect(html).toContain("网页抓取");
    expect(html).toContain("WebFetch");
    expect(html).toContain("x3");
    expect(html).toContain("运行中");
    expect(html).not.toContain("<details open=\"\"");
  });

  it("opens failed activities by default and renders their detail", () => {
    const activities = buildToolActivities([
      event(1, { type: "run.failed", runId: "run_1", error: "Reached maximum number of turns" })
    ], "run_1");

    const html = renderToStaticMarkup(React.createElement(ToolActivityList, {
      activities,
      runId: "run_1",
      onOpenRunDetails: () => undefined
    }));

    expect(html).toContain("open=\"\"");
    expect(html).toContain("运行失败");
    expect(html).toContain("Reached maximum number of turns");
  });

  it("renders drawer summary counts and filter controls", () => {
    const html = renderToStaticMarkup(React.createElement(RunDrawer, {
      open: true,
      events: [
        event(1, { type: "tool.started", runId: "run_1", tool: "WebSearch" }),
        event(2, { type: "command.started", runId: "run_1", command: "npm test" }),
        event(3, { type: "file.changed", runId: "run_1", path: "apps/web/src/App.tsx", diff: "+changed" }),
        event(4, { type: "run.failed", runId: "run_1", error: "failed" })
      ],
      runtime: null,
      session: null,
      runId: "run_1",
      curlExample: "",
      onClose: () => undefined
    }));

    expect(html).toContain("总步数");
    expect(html).toContain("工具调用");
    expect(html).toContain("文件变更");
    expect(html).toContain("All");
    expect(html).toContain("Tools");
    expect(html).toContain("Commands");
    expect(html).toContain("Files");
    expect(html).toContain("Errors");
    expect(html).toContain("Raw event");
  });
});

function event(seq: number, payload: Record<string, unknown>): TimelineEvent {
  return { seq, ...payload } as TimelineEvent;
}
