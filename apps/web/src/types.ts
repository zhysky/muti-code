export type AgentKind = "claude" | "codex" | "opencode";
export type PermissionProfile = "read-only" | "workspace-write";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "aborting" | "aborted" | "timeout";

export interface Agent {
  id: AgentKind;
  name: string;
  default_model: string;
  permission_profiles: PermissionProfile[];
}

export interface Model {
  id: string;
  displayName: string;
  display_name?: string;
  runtimeModel: string;
  provider: string;
}

export interface Session {
  id: string;
  title?: string | null;
  source?: string;
  conversationKey?: string | null;
  workspaceId: string;
  defaultAgent: AgentKind;
  defaultModel: string;
  permissionProfile: PermissionProfile;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface Message {
  id: string;
  sessionId?: string;
  runId?: string | null;
  role: "user" | "assistant" | "system" | string;
  content?: string | null;
  agentKind?: AgentKind | null;
  model?: string | null;
  createdAt?: string;
}

export interface RuntimeStatus {
  driver_mode: string;
  storage: string;
  minimax_ready: boolean;
  anthropic_ready: boolean;
  auth_disabled: boolean;
  opencode_base_url: string;
}

export interface RunRecord {
  id: string;
  sessionId: string;
  agentKind: AgentKind;
  model: string;
  workspaceId: string;
  status: RunStatus;
  errorMessage?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
}

export type TimelineEvent =
  | { seq: number; created_at?: string; type: "run.started"; runId: string }
  | { seq: number; created_at?: string; type: "text.delta"; runId: string; text: string }
  | { seq: number; created_at?: string; type: "message.completed"; runId: string; text: string }
  | { seq: number; created_at?: string; type: "tool.started"; runId: string; tool: string; input?: unknown }
  | { seq: number; created_at?: string; type: "tool.completed"; runId: string; tool: string; output?: unknown }
  | { seq: number; created_at?: string; type: "file.changed"; runId: string; path: string; diff?: string }
  | { seq: number; created_at?: string; type: "command.started"; runId: string; command: string }
  | { seq: number; created_at?: string; type: "command.completed"; runId: string; exitCode: number; output?: string }
  | { seq: number; created_at?: string; type: "run.completed"; runId: string; usage?: unknown }
  | { seq: number; created_at?: string; type: "run.failed"; runId: string; error: string }
  | { seq: number; created_at?: string; type: "run.aborted"; runId: string };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  agentKind?: AgentKind | null;
  model?: string | null;
  runId?: string | null;
  createdAt?: string;
  status?: "streaming" | "completed" | "failed" | "aborted";
  error?: string;
  seenSeq?: Set<number>;
}
