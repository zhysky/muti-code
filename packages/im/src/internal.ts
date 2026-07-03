import type { AgentEvent } from "@agent-gateway/core";
import type { IMAdapter, IMInboundEvent, IMTarget } from "./base.js";

interface InternalWebhookBody {
  event_id?: string;
  conversation_key?: string;
  sender_key?: string;
  text?: string;
  attachments?: unknown[];
}

export class InternalIMAdapter implements IMAdapter {
  readonly outbox: Array<{ target: IMTarget; text?: string; event?: AgentEvent }> = [];

  constructor(readonly kind: "internal" | "feishu" | "wecom" = "internal") {}

  async verify(request: unknown): Promise<boolean> {
    return typeof request === "object" && request !== null;
  }

  async parse(request: unknown): Promise<IMInboundEvent> {
    const body = request as InternalWebhookBody;
    return {
      source: this.kind,
      sourceEventId: body.event_id ?? `internal-${Date.now()}`,
      conversationKey: body.conversation_key ?? "internal-demo",
      senderKey: body.sender_key ?? "demo-user",
      text: body.text ?? "",
      attachments: [],
      raw: request
    };
  }

  async sendAck(target: IMTarget, text: string): Promise<void> {
    this.outbox.push({ target, text });
  }

  async sendEvent(target: IMTarget, event: AgentEvent): Promise<void> {
    this.outbox.push({ target, event });
  }

  async sendFinal(target: IMTarget, text: string): Promise<void> {
    this.outbox.push({ target, text });
  }
}
