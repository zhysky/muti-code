export function renderMetrics(snapshot: { runsTotal: number; sessionsTotal: number }): string {
  return [
    "# HELP agent_gateway_runs_total Total runs created in this process snapshot.",
    "# TYPE agent_gateway_runs_total counter",
    `agent_gateway_runs_total ${snapshot.runsTotal}`,
    "# HELP agent_gateway_sessions_total Total active sessions in this process snapshot.",
    "# TYPE agent_gateway_sessions_total gauge",
    `agent_gateway_sessions_total ${snapshot.sessionsTotal}`
  ].join("\n");
}
