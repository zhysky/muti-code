import { createHash } from "node:crypto";
import { AgentRouter } from "./agent-router.js";
import { EventBus } from "./event-bus.js";
import { buildLiveContext } from "./live-context.js";
import { newId, nowIso } from "./id.js";
import { ModelRouter } from "./model-router.js";
import { PermissionPolicy } from "./permission-policy.js";
import { Sanitizer } from "./sanitizer.js";
import type {
  AgentEvent,
  AgentKind,
  MessageRecord,
  PermissionProfile,
  Repository,
  RunMessageInput,
  RunRecord,
  SessionRecord
} from "./types.js";
import { WorkspaceManager } from "./workspace-manager.js";

interface Services {
  repo: Repository;
  agentRouter: AgentRouter;
  modelRouter: ModelRouter;
  permissionPolicy: PermissionPolicy;
  workspaceManager: WorkspaceManager;
  eventBus: EventBus;
  sanitizer: Sanitizer;
}

export class SessionService {
  constructor(private readonly services: Services) {}

  async create(input: {
    title?: string;
    source?: string;
    conversation_key?: string;
    workspace_id?: string;
    agent?: AgentKind;
    model?: string;
    permission_profile?: PermissionProfile;
  }): Promise<SessionRecord> {
    const agent = input.agent ?? "claude";
    const agentConfig = this.services.agentRouter.get(agent);
    const model = input.model ?? agentConfig.default_model;
    this.services.modelRouter.requireModel(agent, model);
    const permission = input.permission_profile ?? "read-only";
    this.services.permissionPolicy.requireAllowed(permission);
    this.services.agentRouter.assertPermission(agent, permission);
    const workspaceId = input.workspace_id ?? "sample-project";
    await this.services.workspaceManager.ensure(workspaceId, permission);
    const now = nowIso();
    const session: SessionRecord = {
      id: newId("sess"),
      title: input.title ?? "demo session",
      source: input.source ?? "web",
      conversationKey: input.conversation_key ?? null,
      workspaceId,
      defaultAgent: agent,
      defaultModel: model,
      permissionProfile: permission,
      status: "active",
      summary: null,
      createdAt: now,
      updatedAt: now
    };
    await this.services.repo.createSession(session);
    await this.services.repo.createBinding({
      id: newId("bind"),
      sessionId: session.id,
      agentKind: agent,
      runtimeSessionId: `${agent}_${session.id}`,
      model,
      workspaceId,
      createdAt: now,
      updatedAt: now
    });
    await this.services.repo.createAuditLog({
      sessionId: session.id,
      action: "session.created",
      payload: { agent, model, workspaceId, permission },
      createdAt: now
    });
    return session;
  }

  async switchAgent(sessionId: string, input: { agent: AgentKind; model: string }): Promise<SessionRecord> {
    const session = await this.requireSession(sessionId);
    this.services.agentRouter.get(input.agent);
    this.services.modelRouter.requireModel(input.agent, input.model);
    this.services.agentRouter.assertPermission(input.agent, session.permissionProfile);
    const now = nowIso();
    await this.services.repo.upsertBinding({
      id: newId("bind"),
      sessionId,
      agentKind: input.agent,
      runtimeSessionId: `${input.agent}_${sessionId}`,
      model: input.model,
      workspaceId: session.workspaceId,
      createdAt: now,
      updatedAt: now
    });
    return this.services.repo.updateSession(sessionId, {
      defaultAgent: input.agent,
      defaultModel: input.model,
      updatedAt: now
    });
  }

  async reset(sessionId: string): Promise<SessionRecord> {
    const session = await this.requireSession(sessionId);
    await this.services.workspaceManager.reset(session.workspaceId);
    return this.services.repo.updateSession(sessionId, { summary: null, updatedAt: nowIso() });
  }

  async delete(sessionId: string): Promise<SessionRecord> {
    return this.services.repo.updateSession(sessionId, { status: "deleted", updatedAt: nowIso() });
  }

  async requireSession(sessionId: string): Promise<SessionRecord> {
    const session = await this.services.repo.getSession(sessionId);
    if (!session || session.status === "deleted") {
      throw Object.assign(new Error(`Session ${sessionId} not found`), {
        statusCode: 404,
        code: "SESSION_NOT_FOUND"
      });
    }
    return session;
  }
}

export class RunService {
  private readonly active = new Map<string, { agent: AgentKind }>();

  constructor(private readonly services: Services, private readonly sessionService: SessionService) {}

  async sendMessage(sessionId: string, input: RunMessageInput, idempotencyKey?: string): Promise<{
    message_id: string;
    run_id: string;
    status: string;
    stream_url: string;
  }> {
    const session = await this.sessionService.requireSession(sessionId);
    const agent = input.agent ?? session.defaultAgent;
    const modelId = input.model ?? session.defaultModel;
    const permission = input.permission_profile ?? session.permissionProfile;
    this.services.permissionPolicy.requireAllowed(permission);
    this.services.agentRouter.assertPermission(agent, permission);
    const model = this.services.modelRouter.requireModel(agent, modelId);

    if (permission === "workspace-write" && !idempotencyKey) {
      throw Object.assign(new Error("workspace-write messages require Idempotency-Key"), {
        statusCode: 400,
        code: "IDEMPOTENCY_REQUIRED"
      });
    }

    const scope = `messages:${sessionId}`;
    const requestHash = hashJson({ input, agent, modelId, permission });
    if (idempotencyKey) {
      const existing = await this.services.repo.reserveIdempotency({
        key: idempotencyKey,
        scope,
        requestHash,
        responseJson: null,
        runId: null,
        createdAt: nowIso(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      });
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw Object.assign(new Error("Idempotency-Key conflict"), {
            statusCode: 409,
            code: "IDEMPOTENCY_CONFLICT"
          });
        }
        if (!existing.responseJson) {
          throw Object.assign(new Error("Idempotency-Key request is still pending"), {
            statusCode: 409,
            code: "IDEMPOTENCY_PENDING"
          });
        }
        return existing.responseJson as {
          message_id: string;
          run_id: string;
          status: string;
          stream_url: string;
        };
      }
    }

    const now = nowIso();
    const userMessage: MessageRecord = {
      id: newId("msg"),
      sessionId,
      runId: null,
      role: "user",
      content: input.content,
      contentJson: null,
      agentKind: agent,
      model: modelId,
      createdAt: now
    };
    await this.services.repo.createMessage(userMessage);

    const run: RunRecord = {
      id: newId("run"),
      sessionId,
      userMessageId: userMessage.id,
      agentKind: agent,
      model: modelId,
      workspaceId: session.workspaceId,
      status: "queued",
      errorCode: null,
      errorMessage: null,
      startedAt: null,
      endedAt: null,
      metadata: {
        permission_profile: permission,
        provider: model.provider
      }
    };
    await this.services.repo.createRun(run);
    const sessionPatch: Partial<SessionRecord> = {
      defaultAgent: agent,
      defaultModel: modelId,
      permissionProfile: permission,
      updatedAt: nowIso()
    };
    if (shouldAutoTitle(session.title)) {
      sessionPatch.title = summarizeSessionTitle(input.content);
    }
    await this.services.repo.updateSession(sessionId, sessionPatch);

    const response = {
      message_id: userMessage.id,
      run_id: run.id,
      status: "running",
      stream_url: `/api/runs/${run.id}/events`
    };
    if (idempotencyKey) {
      await this.services.repo.updateIdempotency(idempotencyKey, scope, {
        responseJson: response,
        runId: run.id,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      });
    }

    void this.executeRun(run.id, input.content, permission, model.runtime_model);
    return response;
  }

  async abort(runId: string): Promise<RunRecord> {
    const run = await this.requireRun(runId);
    if (["completed", "failed", "aborted", "timeout"].includes(run.status)) {
      return run;
    }
    await this.services.repo.updateRun(runId, { status: "aborting" });
    await this.services.agentRouter.getDriver(run.agentKind).abort(runId);
    const timeoutMs = Number(process.env.ABORT_LOCK_RELEASE_TIMEOUT_MS ?? 1000);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && this.services.workspaceManager.isLocked(run.workspaceId)) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (this.services.workspaceManager.isLocked(run.workspaceId)) {
      this.services.workspaceManager.releaseWriteLock(run.workspaceId, runId);
    }
    await this.persistTerminalIfMissing(runId, { type: "run.aborted", runId });
    return this.services.repo.updateRun(runId, { status: "aborted", endedAt: nowIso() });
  }

  async requireRun(runId: string): Promise<RunRecord> {
    const run = await this.services.repo.getRun(runId);
    if (!run) {
      throw Object.assign(new Error(`Run ${runId} not found`), {
        statusCode: 404,
        code: "RUN_NOT_FOUND"
      });
    }
    return run;
  }

  async latestActiveRun(sessionId: string): Promise<RunRecord | undefined> {
    const runs = await this.services.repo.listRuns(sessionId);
    return runs.find((run) => ["queued", "running", "aborting"].includes(run.status));
  }

  private async executeRun(runId: string, prompt: string, permission: PermissionProfile, runtimeModel: string): Promise<void> {
    const run = await this.requireRun(runId);
    if (run.status === "aborting" || run.status === "aborted") {
      const existingEvents = await this.services.repo.listRunEvents(runId);
      if (!existingEvents.some((event) => event.eventType === "run.aborted")) {
        await this.persistEvent(runId, existingEvents.length + 1, { type: "run.aborted", runId });
      }
      await this.services.repo.updateRun(runId, { status: "aborted", endedAt: nowIso() });
      return;
    }
    const session = await this.sessionService.requireSession(run.sessionId);
    const binding = await this.services.repo.getBinding(run.sessionId, run.agentKind);
    const driver = this.services.agentRouter.getDriver(run.agentKind);
    const workspacePath = await this.services.workspaceManager.ensureExists(run.workspaceId);
    let lock: { release: () => void } | undefined;
    let seq = 0;
    let terminal = false;
    let assistantDraft = "";
    let assistantPersisted = false;
    this.active.set(runId, { agent: run.agentKind });

    const persistAssistantDraft = async () => {
      if (assistantPersisted || !assistantDraft.trim()) return;
      await this.services.repo.createMessage({
        id: newId("msg"),
        sessionId: run.sessionId,
        runId,
        role: "assistant",
        content: assistantDraft,
        contentJson: null,
        agentKind: run.agentKind,
        model: run.model,
        createdAt: nowIso()
      });
      assistantPersisted = true;
    };

    try {
      const needsWorkspaceLock = permission === "workspace-write" || run.agentKind === "opencode";
      if (needsWorkspaceLock) {
        lock = await this.services.workspaceManager.acquireWriteLock(run.workspaceId, runId);
      }
      if (run.agentKind === "opencode") {
        await this.services.workspaceManager.writeOpenCodeConfig(run.workspaceId, permission);
      }
      const beforeStart = await this.requireRun(runId);
      if (beforeStart.status === "aborting" || beforeStart.status === "aborted") {
        if (!terminal) await this.persistTerminalIfMissing(runId, { type: "run.aborted", runId });
        await this.services.repo.updateRun(runId, { status: "aborted", endedAt: nowIso() });
        return;
      }
      await this.services.repo.updateRun(runId, { status: "running", startedAt: nowIso() });
      await this.services.repo.createAuditLog({
        sessionId: run.sessionId,
        runId,
        action: "run.started",
        payload: { agent: run.agentKind, model: run.model, workspaceId: run.workspaceId, permission },
        createdAt: nowIso()
      });

      const liveContext = await buildLiveContext({ prompt });
      if (liveContext) {
        for (const event of liveContext.events) {
          await this.persistEvent(runId, ++seq, this.services.sanitizer.sanitize({ ...event, runId }) as AgentEvent);
        }
      }
      const promptWithLiveContext = buildPromptWithLiveContext(prompt, liveContext?.context);

      for await (const rawEvent of driver.start({
        runId,
        sessionId: run.sessionId,
        agent: run.agentKind,
        model: run.model,
        runtimeModel,
        prompt: buildPromptWithHistory(session.summary, promptWithLiveContext),
        workspaceId: run.workspaceId,
        workspacePath,
        runtimeSessionId: binding?.runtimeSessionId ?? undefined,
        permissionProfile: permission
      })) {
        const current = await this.requireRun(runId);
        if (current.status === "aborting" || current.status === "aborted") {
          await driver.abort(runId);
          if (!terminal) await this.persistEvent(runId, ++seq, { type: "run.aborted", runId });
          await this.services.repo.updateRun(runId, { status: "aborted", endedAt: nowIso() });
          return;
        }
        const event = this.services.sanitizer.sanitize(rawEvent);
        terminal ||= isTerminal(event);
        await this.persistEvent(runId, ++seq, event);
        if (event.type === "text.delta") {
          assistantDraft = appendTextDelta(assistantDraft, event.text);
        }
        if (event.type === "message.completed") {
          await this.services.repo.createMessage({
            id: newId("msg"),
            sessionId: run.sessionId,
            runId,
            role: "assistant",
            content: event.text,
            contentJson: null,
            agentKind: run.agentKind,
            model: run.model,
            createdAt: nowIso()
          });
          assistantPersisted = true;
        }
        if (event.type === "run.aborted") {
          await persistAssistantDraft();
          await this.services.repo.updateRun(runId, { status: "aborted", endedAt: nowIso() });
          return;
        }
        if (event.type === "run.failed") {
          await persistAssistantDraft();
          await this.services.repo.updateRun(runId, {
            status: "failed",
            errorMessage: event.error,
            endedAt: nowIso()
          });
          return;
        }
      }
      const latest = await this.requireRun(runId);
      if (latest.status === "aborting" || latest.status === "aborted") {
        if (!terminal) await this.persistEvent(runId, ++seq, { type: "run.aborted", runId });
        await this.services.repo.updateRun(runId, { status: "aborted", endedAt: nowIso() });
      } else {
        if (!terminal) await this.persistEvent(runId, ++seq, { type: "run.completed", runId });
        await persistAssistantDraft();
        await this.services.repo.updateRun(runId, { status: "completed", endedAt: nowIso() });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const latest = await this.requireRun(runId).catch(() => undefined);
      if (latest?.status === "aborting" || latest?.status === "aborted") {
        if (!terminal) {
          await this.persistTerminalIfMissing(runId, { type: "run.aborted", runId });
        }
        await this.services.repo.updateRun(runId, { status: "aborted", endedAt: nowIso() });
        return;
      }
      if (!terminal) {
        await this.persistEvent(runId, ++seq, { type: "run.failed", runId, error: message });
      }
      await persistAssistantDraft();
      await this.services.repo.updateRun(runId, {
        status: "failed",
        errorCode: error instanceof Error ? (error as Error & { code?: string }).code ?? null : null,
        errorMessage: message,
        endedAt: nowIso()
      });
    } finally {
      await driver.abort(runId).catch(() => undefined);
      lock?.release();
      this.active.delete(runId);
      await this.services.repo.createAuditLog({
        sessionId: run.sessionId,
        runId,
        action: "run.finished",
        payload: { lockReleased: true },
        createdAt: nowIso()
      });
    }
  }

  private async persistEvent(runId: string, seq: number, event: AgentEvent): Promise<void> {
    const record = await this.services.repo.insertRunEvent({
      runId,
      seq,
      eventType: event.type,
      payload: event,
      event,
      createdAt: nowIso()
    });
    await this.services.eventBus.publish(record);
  }

  private async persistTerminalIfMissing(runId: string, event: Extract<AgentEvent, { type: "run.completed" | "run.failed" | "run.aborted" }>): Promise<void> {
    const events = await this.services.repo.listRunEvents(runId);
    if (events.some((item) => isTerminal(item.payload))) {
      return;
    }
    await this.persistEvent(runId, events.length + 1, event);
  }
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isTerminal(event: AgentEvent): boolean {
  return event.type === "run.completed" || event.type === "run.failed" || event.type === "run.aborted";
}

function appendTextDelta(current: string, delta: string): string {
  if (!delta) return current;
  if (current && delta.startsWith(current)) return delta;
  if (delta.length >= 8 && current.endsWith(delta)) return current;
  return `${current}${delta}`;
}

function buildPromptWithHistory(summary: string | null | undefined, prompt: string): string {
  if (!summary) return prompt;
  return `你正在接手一个已有任务。\n\n历史摘要：\n${summary}\n\n用户新请求：\n${prompt}`;
}

function buildPromptWithLiveContext(prompt: string, liveContext?: string): string {
  if (!liveContext) return prompt;
  return [
    "系统已为本轮请求准备以下实时上下文：",
    liveContext,
    "",
    "用户原始请求：",
    prompt
  ].join("\n");
}

function shouldAutoTitle(title: string | null | undefined): boolean {
  return !title || title === "New chat" || title === "demo session";
}

function summarizeSessionTitle(content: string): string {
  const firstLine = content.replace(/\s+/g, " ").trim();
  if (firstLine.length <= 18) return firstLine;
  return `${firstLine.slice(0, 18)}...`;
}
