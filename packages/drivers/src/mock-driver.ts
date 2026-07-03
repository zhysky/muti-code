import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentEvent, AgentKind, AgentRunRequest } from "@agent-gateway/core";
import { BaseDriver, isWritePrompt } from "./base.js";

export class MockAgentDriver extends BaseDriver {
  constructor(kind: AgentKind) {
    super(kind, "mock");
  }

  async *start(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    const controller = this.controllerFor(request.runId);
    try {
      yield { type: "run.started", runId: request.runId };
      await delay(mockDelayMs(), controller.signal);
      yield {
        type: "text.delta",
        runId: request.runId,
        text: `[${this.kind}] using ${request.model}: `
      };
      await delay(mockDelayMs(), controller.signal);
      yield {
        type: "tool.started",
        runId: request.runId,
        tool: "read_file",
        input: { path: "package.json" }
      };
      yield {
        type: "tool.completed",
        runId: request.runId,
        tool: "read_file",
        output: "sample-project inspected"
      };

      if (isWritePrompt(request.prompt)) {
        if (request.permissionProfile !== "workspace-write") {
          yield {
            type: "message.completed",
            runId: request.runId,
            text: `${this.kind} refused to write because permission_profile is read-only.`
          };
        } else {
          const target = path.join(request.workspacePath, "AGENT_OUTPUT.md");
          await mkdir(request.workspacePath, { recursive: true });
          const before = await readFile(target, "utf8").catch(() => "");
          const after = `${before}Run ${request.runId} handled by ${this.kind} with ${request.model}.\nPrompt: ${request.prompt}\n`;
          await writeFile(target, after);
          yield {
            type: "file.changed",
            runId: request.runId,
            path: "AGENT_OUTPUT.md",
            diff: `--- a/AGENT_OUTPUT.md\n+++ b/AGENT_OUTPUT.md\n-${before}\n+${after}`
          };
          yield {
            type: "message.completed",
            runId: request.runId,
            text: `${this.kind} wrote AGENT_OUTPUT.md inside the workspace.`
          };
        }
      } else if (isLiveInfoPrompt(request.prompt)) {
        yield {
          type: "message.completed",
          runId: request.runId,
          text: [
            `当前是 mock 演示模式，${this.kind} 没有调用真实模型或联网查询实时信息，所以不能直接回答天气、新闻、价格这类实时问题。`,
            "要验证真实回答，请用 MINIMAX_API_KEY 和 AGENT_DRIVER_MODE=real 启动；这个演示回复只用于检查会话、流式输出、事件时间线和 Agent 切换链路。"
          ].join("\n")
        };
      } else {
        yield {
          type: "message.completed",
          runId: request.runId,
          text: `${this.kind} 已检查当前 workspace：这是一个 TypeScript 多 Agent Gateway 演示项目，可继续让我分析启动方式、修改代码、查看 diff 或验证接口。`
        };
      }

      yield { type: "run.completed", runId: request.runId, usage: { mode: "mock" } };
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
}

function mockDelayMs(): number {
  return Number(process.env.MOCK_DRIVER_DELAY_MS ?? 20);
}

function isLiveInfoPrompt(prompt: string): boolean {
  return /天气|气温|新闻|最新|今天|现在|价格|股价|汇率|weather|news|latest|today|current|price/i.test(prompt);
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error("aborted");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    }, { once: true });
  });
}
