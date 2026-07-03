import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AgentRouter,
  EventBus,
  ModelRouter,
  PermissionPolicy,
  RunService,
  Sanitizer,
  SessionService,
  WorkspaceManager,
  loadGatewayConfig
} from "@agent-gateway/core";
import { InMemoryRepository } from "@agent-gateway/db";
import { ClaudeDriver, CodexDriver, OpenCodeDriver } from "@agent-gateway/drivers";
import type { AgentDriver } from "@agent-gateway/core";

export async function makeTestServices(customDrivers?: AgentDriver[], customWorkspaceManager?: WorkspaceManager) {
  const repoRoot = path.resolve(new URL(".", import.meta.url).pathname, "..");
  const temp = await mkdtemp(path.join(os.tmpdir(), "agent-gateway-test-"));
  const config = await loadGatewayConfig(path.join(repoRoot, "config"));
  const repo = new InMemoryRepository();
  const workspaceManager = customWorkspaceManager ?? new WorkspaceManager(
    path.join(temp, "workspaces"),
    path.join(repoRoot, "sample-project"),
    path.join(temp, "snapshots")
  );
  await workspaceManager.init();
  const modelRouter = new ModelRouter(config.models);
  const agentRouter = new AgentRouter(config.agents, customDrivers ?? [
    new ClaudeDriver("mock"),
    new CodexDriver("mock"),
    new OpenCodeDriver("mock")
  ], modelRouter);
  const permissionPolicy = new PermissionPolicy(config.permissions);
  const eventBus = new EventBus({ disabled: true });
  const sanitizer = new Sanitizer();
  const serviceBundle = {
    repo,
    agentRouter,
    modelRouter,
    permissionPolicy,
    workspaceManager,
    eventBus,
    sanitizer
  };
  const sessionService = new SessionService(serviceBundle);
  const runService = new RunService(serviceBundle, sessionService);
  return {
    repo,
    workspaceManager,
    modelRouter,
    agentRouter,
    permissionPolicy,
    eventBus,
    sanitizer,
    sessionService,
    runService,
    temp
  };
}

export async function waitForRunDone(services: Awaited<ReturnType<typeof makeTestServices>>, runId: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const run = await services.repo.getRun(runId);
    if (run && ["completed", "failed", "aborted", "timeout"].includes(run.status)) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`run ${runId} did not finish`);
}
