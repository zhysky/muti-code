export type AgentKind = "claude" | "codex" | "opencode";

export type PermissionProfile =
  | "read-only"
  | "workspace-write"
  | "auto"
  | "dangerous-admin";

export type RunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "aborting"
  | "aborted"
  | "timeout";

export interface AgentRunRequest {
  runId: string;
  sessionId: string;
  agent: AgentKind;
  model: string;
  runtimeModel: string;
  prompt: string;
  workspaceId: string;
  workspacePath: string;
  runtimeSessionId?: string;
  permissionProfile: PermissionProfile;
  allowedTools?: string[];
  metadata?: Record<string, unknown>;
}

export type AgentEvent =
  | { type: "run.started"; runId: string }
  | { type: "text.delta"; runId: string; text: string }
  | { type: "message.completed"; runId: string; text: string }
  | { type: "tool.started"; runId: string; tool: string; input?: unknown }
  | { type: "tool.completed"; runId: string; tool: string; output?: unknown }
  | { type: "file.changed"; runId: string; path: string; diff?: string }
  | { type: "command.started"; runId: string; command: string }
  | { type: "command.completed"; runId: string; exitCode: number; output?: string }
  | { type: "run.completed"; runId: string; usage?: unknown }
  | { type: "run.failed"; runId: string; error: string }
  | { type: "run.aborted"; runId: string };

export interface SequencedAgentEvent {
  seq: number;
  event: AgentEvent;
  createdAt: string;
}

export interface AgentHealth {
  ok: boolean;
  mode: "mock" | "cli" | "sdk" | "http";
  details?: Record<string, unknown>;
}

export interface AgentModel {
  id: string;
  runtimeModel: string;
  displayName: string;
  provider: string;
}

export interface AgentDriver {
  kind: AgentKind;
  start(request: AgentRunRequest): AsyncIterable<AgentEvent>;
  abort(runId: string): Promise<void>;
  health(): Promise<AgentHealth>;
  listModels?(): Promise<AgentModel[]>;
}

export interface AgentConfig {
  id: AgentKind;
  name: string;
  driver: AgentKind;
  enabled: boolean;
  default_model: string;
  permission_profiles: PermissionProfile[];
}

export interface ModelConfig {
  id: string;
  agent: AgentKind;
  runtime_model: string;
  display_name: string;
  provider: string;
  enabled: boolean;
  expensive?: boolean;
}

export interface PermissionConfig {
  description?: string;
  allow_write?: boolean;
  allow_shell?: boolean | "limited";
  allow_network?: boolean | "limited";
  enabled?: boolean;
}

export interface SessionRecord {
  id: string;
  title?: string | null;
  source: string;
  conversationKey?: string | null;
  workspaceId: string;
  defaultAgent: AgentKind;
  defaultModel: string;
  permissionProfile: PermissionProfile;
  status: "active" | "deleted";
  summary?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionAgentBindingRecord {
  id: string;
  sessionId: string;
  agentKind: AgentKind;
  runtimeSessionId?: string | null;
  model?: string | null;
  workspaceId: string;
  createdAt: string;
  updatedAt: string;
}

export interface MessageRecord {
  id: string;
  sessionId: string;
  runId?: string | null;
  role: "user" | "assistant" | "system";
  content?: string | null;
  contentJson?: unknown;
  agentKind?: AgentKind | null;
  model?: string | null;
  createdAt: string;
}

export interface RunRecord {
  id: string;
  sessionId: string;
  userMessageId?: string | null;
  agentKind: AgentKind;
  model: string;
  workspaceId: string;
  status: RunStatus;
  errorCode?: string | null;
  errorMessage?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface RunEventRecord extends SequencedAgentEvent {
  id?: number;
  runId: string;
  eventType: AgentEvent["type"];
  payload: AgentEvent;
}

export interface IdempotencyRecord {
  key: string;
  scope: string;
  requestHash: string;
  responseJson?: unknown;
  runId?: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface AuditLogRecord {
  sessionId?: string | null;
  runId?: string | null;
  action: string;
  payload?: unknown;
  createdAt: string;
}

export interface Repository {
  ping(): Promise<void>;
  createSession(record: SessionRecord): Promise<SessionRecord>;
  listSessions(): Promise<SessionRecord[]>;
  getSession(id: string): Promise<SessionRecord | undefined>;
  updateSession(id: string, patch: Partial<SessionRecord>): Promise<SessionRecord>;
  createBinding(record: SessionAgentBindingRecord): Promise<SessionAgentBindingRecord>;
  upsertBinding(record: SessionAgentBindingRecord): Promise<SessionAgentBindingRecord>;
  getBinding(sessionId: string, agent: AgentKind): Promise<SessionAgentBindingRecord | undefined>;
  createMessage(record: MessageRecord): Promise<MessageRecord>;
  listMessages(sessionId: string): Promise<MessageRecord[]>;
  createRun(record: RunRecord): Promise<RunRecord>;
  listRuns(sessionId?: string): Promise<RunRecord[]>;
  getRun(id: string): Promise<RunRecord | undefined>;
  updateRun(id: string, patch: Partial<RunRecord>): Promise<RunRecord>;
  insertRunEvent(record: Omit<RunEventRecord, "id">): Promise<RunEventRecord>;
  listRunEvents(runId: string): Promise<RunEventRecord[]>;
  createAuditLog(record: AuditLogRecord): Promise<void>;
  getIdempotency(key: string, scope: string): Promise<IdempotencyRecord | undefined>;
  reserveIdempotency(record: IdempotencyRecord): Promise<IdempotencyRecord | undefined>;
  saveIdempotency(record: IdempotencyRecord): Promise<IdempotencyRecord>;
  updateIdempotency(key: string, scope: string, patch: Partial<IdempotencyRecord>): Promise<IdempotencyRecord>;
  hasDedupKey(key: string): Promise<boolean>;
  saveDedupKey(key: string, ttlSeconds: number): Promise<void>;
}

export interface WorkspaceSummary {
  id: string;
  path: string;
  locked: boolean;
}

export interface RunMessageInput {
  content: string;
  agent?: AgentKind;
  model?: string;
  stream?: boolean;
  permission_profile?: PermissionProfile;
}
