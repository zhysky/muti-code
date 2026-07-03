import { spawn } from "node:child_process";
import type { AgentDriver, AgentEvent, AgentHealth, AgentKind, AgentRunRequest } from "@agent-gateway/core";

export abstract class BaseDriver implements AgentDriver {
  protected readonly abortControllers = new Map<string, AbortController>();

  constructor(readonly kind: AgentKind, protected readonly mode: "mock" | "cli" | "sdk" | "http" = "mock") {}

  abstract start(request: AgentRunRequest): AsyncIterable<AgentEvent>;

  async abort(runId: string): Promise<void> {
    const controller = this.abortControllers.get(runId);
    controller?.abort();
    this.abortControllers.delete(runId);
  }

  async health(): Promise<AgentHealth> {
    return { ok: true, mode: this.mode };
  }

  protected controllerFor(runId: string): AbortController {
    const controller = new AbortController();
    this.abortControllers.set(runId, controller);
    return controller;
  }

  protected cleanup(runId: string): void {
    this.abortControllers.delete(runId);
  }
}

export async function commandExists(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-lc", `command -v ${command}`], { stdio: "ignore" });
    child.on("exit", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

export function isWritePrompt(prompt: string): boolean {
  return /write|edit|modify|create|append|更新|修改|写入|创建|新增|README|file/i.test(prompt);
}
