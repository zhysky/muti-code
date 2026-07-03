import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../apps/web/src/api.js";

describe("web api client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not send a json content-type for bodyless POST requests", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));

    await api.abortRun("run_1");

    expect(fetchMock).toHaveBeenCalledWith("/api/runs/run_1/abort", {
      method: "POST"
    });
  });

  it("parses replayed run events from an SSE response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response([
      ": connected",
      "",
      "event: run.started",
      "data: {\"seq\":1,\"type\":\"run.started\",\"runId\":\"run_1\"}",
      "",
      "event: run.completed",
      "data: {\"seq\":2,\"type\":\"run.completed\",\"runId\":\"run_1\"}",
      "",
    ].join("\n"), {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    }));

    await expect(api.listRunEvents("run_1")).resolves.toEqual({
      events: [
        { seq: 1, type: "run.started", runId: "run_1" },
        { seq: 2, type: "run.completed", runId: "run_1" }
      ]
    });
  });
});
