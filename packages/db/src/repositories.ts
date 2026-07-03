import { Pool } from "pg";
import type {
  AgentKind,
  AuditLogRecord,
  IdempotencyRecord,
  MessageRecord,
  Repository,
  RunEventRecord,
  RunRecord,
  SessionAgentBindingRecord,
  SessionRecord
} from "@agent-gateway/core";
import { migrations } from "./schema.js";

export class InMemoryRepository implements Repository {
  private sessions = new Map<string, SessionRecord>();
  private bindings = new Map<string, SessionAgentBindingRecord>();
  private messages = new Map<string, MessageRecord>();
  private runs = new Map<string, RunRecord>();
  private events = new Map<string, RunEventRecord[]>();
  private idempotency = new Map<string, IdempotencyRecord>();
  private dedup = new Map<string, number>();
  readonly auditLogs: AuditLogRecord[] = [];

  async ping(): Promise<void> {}

  async createSession(record: SessionRecord): Promise<SessionRecord> {
    this.sessions.set(record.id, record);
    return record;
  }

  async listSessions(): Promise<SessionRecord[]> {
    return [...this.sessions.values()]
      .filter((session) => session.status !== "deleted")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getSession(id: string): Promise<SessionRecord | undefined> {
    return this.sessions.get(id);
  }

  async updateSession(id: string, patch: Partial<SessionRecord>): Promise<SessionRecord> {
    const current = requireValue(this.sessions.get(id), "session");
    const next = { ...current, ...patch };
    this.sessions.set(id, next);
    return next;
  }

  async createBinding(record: SessionAgentBindingRecord): Promise<SessionAgentBindingRecord> {
    this.bindings.set(bindingKey(record.sessionId, record.agentKind), record);
    return record;
  }

  async upsertBinding(record: SessionAgentBindingRecord): Promise<SessionAgentBindingRecord> {
    this.bindings.set(bindingKey(record.sessionId, record.agentKind), record);
    return record;
  }

  async getBinding(sessionId: string, agent: AgentKind): Promise<SessionAgentBindingRecord | undefined> {
    return this.bindings.get(bindingKey(sessionId, agent));
  }

  async createMessage(record: MessageRecord): Promise<MessageRecord> {
    this.messages.set(record.id, record);
    return record;
  }

  async listMessages(sessionId: string): Promise<MessageRecord[]> {
    return [...this.messages.values()]
      .filter((message) => message.sessionId === sessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async createRun(record: RunRecord): Promise<RunRecord> {
    this.runs.set(record.id, record);
    return record;
  }

  async listRuns(sessionId?: string): Promise<RunRecord[]> {
    return [...this.runs.values()]
      .filter((run) => !sessionId || run.sessionId === sessionId)
      .reverse();
  }

  async getRun(id: string): Promise<RunRecord | undefined> {
    return this.runs.get(id);
  }

  async updateRun(id: string, patch: Partial<RunRecord>): Promise<RunRecord> {
    const current = requireValue(this.runs.get(id), "run");
    const next = { ...current, ...patch };
    this.runs.set(id, next);
    return next;
  }

  async insertRunEvent(record: Omit<RunEventRecord, "id">): Promise<RunEventRecord> {
    const list = this.events.get(record.runId) ?? [];
    const next = { ...record, id: list.length + 1 };
    list.push(next);
    this.events.set(record.runId, list);
    return next;
  }

  async listRunEvents(runId: string): Promise<RunEventRecord[]> {
    return [...(this.events.get(runId) ?? [])].sort((a, b) => a.seq - b.seq);
  }

  async createAuditLog(record: AuditLogRecord): Promise<void> {
    this.auditLogs.push(record);
  }

  async getIdempotency(key: string, scope: string): Promise<IdempotencyRecord | undefined> {
    const record = this.idempotency.get(`${scope}:${key}`);
    if (!record) return undefined;
    if (new Date(record.expiresAt).getTime() <= Date.now()) {
      this.idempotency.delete(`${scope}:${key}`);
      return undefined;
    }
    return record;
  }

  async reserveIdempotency(record: IdempotencyRecord): Promise<IdempotencyRecord | undefined> {
    const key = `${record.scope}:${record.key}`;
    const existing = await this.getIdempotency(record.key, record.scope);
    if (existing) return existing;
    this.idempotency.set(key, record);
    return undefined;
  }

  async saveIdempotency(record: IdempotencyRecord): Promise<IdempotencyRecord> {
    this.idempotency.set(`${record.scope}:${record.key}`, record);
    return record;
  }

  async updateIdempotency(key: string, scope: string, patch: Partial<IdempotencyRecord>): Promise<IdempotencyRecord> {
    const current = requireValue(this.idempotency.get(`${scope}:${key}`), "idempotency");
    const next = { ...current, ...patch };
    this.idempotency.set(`${scope}:${key}`, next);
    return next;
  }

  async hasDedupKey(key: string): Promise<boolean> {
    const expires = this.dedup.get(key);
    if (!expires) return false;
    if (expires < Date.now()) {
      this.dedup.delete(key);
      return false;
    }
    return true;
  }

  async saveDedupKey(key: string, ttlSeconds: number): Promise<void> {
    this.dedup.set(key, Date.now() + ttlSeconds * 1000);
  }
}

export class PostgresRepository implements Repository {
  readonly pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl });
  }

  async migrate(): Promise<void> {
    for (const migration of migrations) {
      await this.pool.query(migration.sql);
    }
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async createSession(record: SessionRecord): Promise<SessionRecord> {
    await this.pool.query(
      `INSERT INTO sessions (id, title, source, conversation_key, workspace_id, default_agent, default_model, permission_profile, status, summary, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        record.id,
        record.title,
        record.source,
        record.conversationKey,
        record.workspaceId,
        record.defaultAgent,
        record.defaultModel,
        record.permissionProfile,
        record.status,
        record.summary,
        record.createdAt,
        record.updatedAt
      ]
    );
    return record;
  }

  async listSessions(): Promise<SessionRecord[]> {
    const rows = await this.pool.query("SELECT * FROM sessions WHERE status <> 'deleted' ORDER BY updated_at DESC");
    return rows.rows.map(mapSession);
  }

  async getSession(id: string): Promise<SessionRecord | undefined> {
    const rows = await this.pool.query("SELECT * FROM sessions WHERE id=$1", [id]);
    return rows.rows[0] ? mapSession(rows.rows[0]) : undefined;
  }

  async updateSession(id: string, patch: Partial<SessionRecord>): Promise<SessionRecord> {
    const current = requireValue(await this.getSession(id), "session");
    const next = { ...current, ...patch };
    await this.pool.query(
      `UPDATE sessions SET title=$2, source=$3, conversation_key=$4, workspace_id=$5, default_agent=$6, default_model=$7,
       permission_profile=$8, status=$9, summary=$10, created_at=$11, updated_at=$12 WHERE id=$1`,
      [
        id,
        next.title,
        next.source,
        next.conversationKey,
        next.workspaceId,
        next.defaultAgent,
        next.defaultModel,
        next.permissionProfile,
        next.status,
        next.summary,
        next.createdAt,
        next.updatedAt
      ]
    );
    return next;
  }

  async createBinding(record: SessionAgentBindingRecord): Promise<SessionAgentBindingRecord> {
    return this.upsertBinding(record);
  }

  async upsertBinding(record: SessionAgentBindingRecord): Promise<SessionAgentBindingRecord> {
    await this.pool.query(
      `INSERT INTO session_agent_bindings (id, session_id, agent_kind, runtime_session_id, model, workspace_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (session_id, agent_kind)
       DO UPDATE SET runtime_session_id=$4, model=$5, workspace_id=$6, updated_at=$8`,
      [
        record.id,
        record.sessionId,
        record.agentKind,
        record.runtimeSessionId,
        record.model,
        record.workspaceId,
        record.createdAt,
        record.updatedAt
      ]
    );
    return record;
  }

  async getBinding(sessionId: string, agent: AgentKind): Promise<SessionAgentBindingRecord | undefined> {
    const rows = await this.pool.query("SELECT * FROM session_agent_bindings WHERE session_id=$1 AND agent_kind=$2", [sessionId, agent]);
    return rows.rows[0] ? mapBinding(rows.rows[0]) : undefined;
  }

  async createMessage(record: MessageRecord): Promise<MessageRecord> {
    await this.pool.query(
      `INSERT INTO messages (id, session_id, run_id, role, content, content_json, agent_kind, model, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        record.id,
        record.sessionId,
        record.runId,
        record.role,
        record.content,
        JSON.stringify(record.contentJson ?? null),
        record.agentKind,
        record.model,
        record.createdAt
      ]
    );
    return record;
  }

  async listMessages(sessionId: string): Promise<MessageRecord[]> {
    const rows = await this.pool.query("SELECT * FROM messages WHERE session_id=$1 ORDER BY created_at ASC", [sessionId]);
    return rows.rows.map(mapMessage);
  }

  async createRun(record: RunRecord): Promise<RunRecord> {
    await this.pool.query(
      `INSERT INTO runs (id, session_id, user_message_id, agent_kind, model, workspace_id, status, error_code, error_message, started_at, ended_at, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        record.id,
        record.sessionId,
        record.userMessageId,
        record.agentKind,
        record.model,
        record.workspaceId,
        record.status,
        record.errorCode,
        record.errorMessage,
        record.startedAt,
        record.endedAt,
        JSON.stringify(record.metadata ?? {})
      ]
    );
    return record;
  }

  async listRuns(sessionId?: string): Promise<RunRecord[]> {
    const rows = sessionId
      ? await this.pool.query("SELECT * FROM runs WHERE session_id=$1 ORDER BY started_at DESC NULLS FIRST", [sessionId])
      : await this.pool.query("SELECT * FROM runs ORDER BY started_at DESC NULLS FIRST");
    return rows.rows.map(mapRun);
  }

  async getRun(id: string): Promise<RunRecord | undefined> {
    const rows = await this.pool.query("SELECT * FROM runs WHERE id=$1", [id]);
    return rows.rows[0] ? mapRun(rows.rows[0]) : undefined;
  }

  async updateRun(id: string, patch: Partial<RunRecord>): Promise<RunRecord> {
    const current = requireValue(await this.getRun(id), "run");
    const next = { ...current, ...patch };
    await this.pool.query(
      `UPDATE runs SET session_id=$2, user_message_id=$3, agent_kind=$4, model=$5, workspace_id=$6, status=$7,
       error_code=$8, error_message=$9, started_at=$10, ended_at=$11, metadata=$12 WHERE id=$1`,
      [
        id,
        next.sessionId,
        next.userMessageId,
        next.agentKind,
        next.model,
        next.workspaceId,
        next.status,
        next.errorCode,
        next.errorMessage,
        next.startedAt,
        next.endedAt,
        JSON.stringify(next.metadata ?? {})
      ]
    );
    return next;
  }

  async insertRunEvent(record: Omit<RunEventRecord, "id">): Promise<RunEventRecord> {
    const rows = await this.pool.query(
      `INSERT INTO run_events (run_id, seq, event_type, payload, created_at)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [record.runId, record.seq, record.eventType, JSON.stringify(record.payload), record.createdAt]
    );
    return { ...record, id: Number(rows.rows[0].id) };
  }

  async listRunEvents(runId: string): Promise<RunEventRecord[]> {
    const rows = await this.pool.query("SELECT * FROM run_events WHERE run_id=$1 ORDER BY seq ASC", [runId]);
    return rows.rows.map(mapRunEvent);
  }

  async createAuditLog(record: AuditLogRecord): Promise<void> {
    await this.pool.query(
      "INSERT INTO audit_logs (session_id, run_id, action, payload, created_at) VALUES ($1,$2,$3,$4,$5)",
      [record.sessionId, record.runId, record.action, JSON.stringify(record.payload ?? {}), record.createdAt]
    );
  }

  async getIdempotency(key: string, scope: string): Promise<IdempotencyRecord | undefined> {
    const rows = await this.pool.query("SELECT * FROM idempotency_keys WHERE key=$1 AND scope=$2 AND expires_at > NOW()", [key, scope]);
    return rows.rows[0] ? mapIdempotency(rows.rows[0]) : undefined;
  }

  async reserveIdempotency(record: IdempotencyRecord): Promise<IdempotencyRecord | undefined> {
    await this.pool.query("DELETE FROM idempotency_keys WHERE key=$1 AND scope=$2 AND expires_at <= NOW()", [record.key, record.scope]);
    const inserted = await this.pool.query(
      `INSERT INTO idempotency_keys (key, scope, request_hash, response_json, run_id, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (key, scope) DO NOTHING
       RETURNING key`,
      [record.key, record.scope, record.requestHash, JSON.stringify(record.responseJson ?? null), record.runId, record.createdAt, record.expiresAt]
    );
    if ((inserted.rowCount ?? 0) > 0) {
      return undefined;
    }
    return this.getIdempotency(record.key, record.scope);
  }

  async saveIdempotency(record: IdempotencyRecord): Promise<IdempotencyRecord> {
    await this.pool.query(
      `INSERT INTO idempotency_keys (key, scope, request_hash, response_json, run_id, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [record.key, record.scope, record.requestHash, JSON.stringify(record.responseJson ?? null), record.runId, record.createdAt, record.expiresAt]
    );
    return record;
  }

  async updateIdempotency(key: string, scope: string, patch: Partial<IdempotencyRecord>): Promise<IdempotencyRecord> {
    const current = requireValue(await this.getIdempotency(key, scope), "idempotency");
    const next = { ...current, ...patch };
    await this.pool.query(
      `UPDATE idempotency_keys SET request_hash=$3, response_json=$4, run_id=$5, created_at=$6, expires_at=$7 WHERE key=$1 AND scope=$2`,
      [key, scope, next.requestHash, JSON.stringify(next.responseJson ?? null), next.runId, next.createdAt, next.expiresAt]
    );
    return next;
  }

  async hasDedupKey(key: string): Promise<boolean> {
    const rows = await this.pool.query("SELECT key FROM im_dedup_keys WHERE key=$1 AND expires_at > NOW()", [key]);
    return (rows.rowCount ?? 0) > 0;
  }

  async saveDedupKey(key: string, ttlSeconds: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO im_dedup_keys (key, expires_at) VALUES ($1, NOW() + ($2 || ' seconds')::interval)
       ON CONFLICT (key) DO UPDATE SET expires_at=EXCLUDED.expires_at`,
      [key, ttlSeconds]
    );
  }
}

export function createRepository(databaseUrl?: string): Repository {
  if (!databaseUrl || process.env.DEMO_STORAGE === "memory") {
    return new InMemoryRepository();
  }
  return new PostgresRepository(databaseUrl);
}

function bindingKey(sessionId: string, agent: AgentKind): string {
  return `${sessionId}:${agent}`;
}

function requireValue<T>(value: T | undefined, name: string): T {
  if (!value) {
    throw Object.assign(new Error(`${name} not found`), { statusCode: 404, code: `${name.toUpperCase()}_NOT_FOUND` });
  }
  return value;
}

function mapSession(row: Record<string, unknown>): SessionRecord {
  return {
    id: String(row.id),
    title: row.title as string | null,
    source: String(row.source),
    conversationKey: row.conversation_key as string | null,
    workspaceId: String(row.workspace_id),
    defaultAgent: row.default_agent as AgentKind,
    defaultModel: String(row.default_model),
    permissionProfile: row.permission_profile as SessionRecord["permissionProfile"],
    status: row.status as SessionRecord["status"],
    summary: row.summary as string | null,
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString()
  };
}

function mapBinding(row: Record<string, unknown>): SessionAgentBindingRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    agentKind: row.agent_kind as AgentKind,
    runtimeSessionId: row.runtime_session_id as string | null,
    model: row.model as string | null,
    workspaceId: String(row.workspace_id),
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString()
  };
}

function mapMessage(row: Record<string, unknown>): MessageRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    runId: row.run_id as string | null,
    role: row.role as MessageRecord["role"],
    content: row.content as string | null,
    contentJson: row.content_json,
    agentKind: row.agent_kind as AgentKind | null,
    model: row.model as string | null,
    createdAt: new Date(row.created_at as string).toISOString()
  };
}

function mapRun(row: Record<string, unknown>): RunRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    userMessageId: row.user_message_id as string | null,
    agentKind: row.agent_kind as AgentKind,
    model: String(row.model),
    workspaceId: String(row.workspace_id),
    status: row.status as RunRecord["status"],
    errorCode: row.error_code as string | null,
    errorMessage: row.error_message as string | null,
    startedAt: row.started_at ? new Date(row.started_at as string).toISOString() : null,
    endedAt: row.ended_at ? new Date(row.ended_at as string).toISOString() : null,
    metadata: row.metadata as Record<string, unknown> | null
  };
}

function mapRunEvent(row: Record<string, unknown>): RunEventRecord {
  return {
    id: Number(row.id),
    runId: String(row.run_id),
    seq: Number(row.seq),
    eventType: row.event_type as RunEventRecord["eventType"],
    payload: row.payload as RunEventRecord["payload"],
    event: row.payload as RunEventRecord["event"],
    createdAt: new Date(row.created_at as string).toISOString()
  };
}

function mapIdempotency(row: Record<string, unknown>): IdempotencyRecord {
  return {
    key: String(row.key),
    scope: String(row.scope),
    requestHash: String(row.request_hash),
    responseJson: row.response_json,
    runId: row.run_id as string | null,
    createdAt: new Date(row.created_at as string).toISOString(),
    expiresAt: new Date(row.expires_at as string).toISOString()
  };
}
