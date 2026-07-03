import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: {
    service: "multi-agent-gateway"
  }
});

export function logContext(context: Record<string, unknown>): Record<string, unknown> {
  return {
    trace_id: context.trace_id ?? context.traceId ?? null,
    session_id: context.session_id ?? context.sessionId ?? null,
    run_id: context.run_id ?? context.runId ?? null,
    agent_kind: context.agent_kind ?? context.agentKind ?? null,
    model: context.model ?? null,
    workspace_id: context.workspace_id ?? context.workspaceId ?? null,
    driver: context.driver ?? null,
    provider: context.provider ?? null,
    im_source: context.im_source ?? context.imSource ?? null
  };
}
