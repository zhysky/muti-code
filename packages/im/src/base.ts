import type { AgentEvent } from "@agent-gateway/core";

export interface Attachment {
  name: string;
  url?: string;
  contentType?: string;
}

export interface IMTarget {
  conversationKey: string;
  senderKey?: string;
}

export interface IMInboundEvent {
  source: string;
  sourceEventId: string;
  conversationKey: string;
  senderKey: string;
  text: string;
  attachments: Attachment[];
  raw: unknown;
}

export interface IMAdapter {
  kind: "feishu" | "wecom" | "internal";
  verify(request: unknown): Promise<boolean>;
  parse(request: unknown): Promise<IMInboundEvent>;
  sendAck(target: IMTarget, text: string): Promise<void>;
  sendEvent(target: IMTarget, event: AgentEvent): Promise<void>;
  sendFinal(target: IMTarget, text: string): Promise<void>;
}

export type IMCommand =
  | { type: "agent"; value?: string }
  | { type: "model"; value?: string }
  | { type: "new" }
  | { type: "reset" }
  | { type: "abort" }
  | { type: "status" }
  | { type: "help" }
  | { type: "message"; value: string };

export function parseCommand(text: string): IMCommand {
  const trimmed = text.trim();
  if (trimmed === "/agent") return { type: "agent" };
  if (trimmed.startsWith("/agent ")) return { type: "agent", value: trimmed.split(/\s+/)[1] };
  if (trimmed === "/model") return { type: "model" };
  if (trimmed.startsWith("/model ")) return { type: "model", value: trimmed.split(/\s+/)[1] };
  if (trimmed === "/new") return { type: "new" };
  if (trimmed === "/reset") return { type: "reset" };
  if (trimmed === "/abort") return { type: "abort" };
  if (trimmed === "/status") return { type: "status" };
  if (trimmed === "/help") return { type: "help" };
  return { type: "message", value: trimmed };
}
