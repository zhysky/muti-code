import type { Agent, AgentKind, Model } from "../types.js";

export const productCopy = {
  brand: "Multi-Agent Gateway",
  newSession: "新会话",
  recentSessions: "最近",
  emptySession: "还没有会话",
  emptyTitle: "今天想让哪个 Agent 处理？",
  emptyDescription: "统一接入 Claude Code、Codex、OpenCode，默认走 MiniMax-M3；支持代码修改、命令执行、工作区 diff 与流式事件追踪。",
  composerPlaceholder: "描述要交给 Agent 的任务，Enter 发送，Shift+Enter 换行；支持粘贴上下文 / 文件路径 / 命令输出"
} as const;

export function agentDisplayName(agent: AgentKind | string): string {
  if (agent === "claude") return "Claude Code";
  if (agent === "codex") return "Codex";
  if (agent === "opencode") return "OpenCode";
  return agent || "Agent";
}

export function defaultModelForAgent(
  agent: AgentKind,
  agents: Agent[],
  models: Model[],
  currentModel?: string
): string {
  return models.find((item) => item.id === currentModel)?.id
    ?? models.find((item) => item.id === agents.find((item) => item.id === agent)?.default_model)?.id
    ?? models[0]?.id
    ?? "";
}
