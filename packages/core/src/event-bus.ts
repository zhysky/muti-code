import { Redis } from "ioredis";
import type { AgentEvent, RunEventRecord, SequencedAgentEvent } from "./types.js";

type Subscriber = (event: SequencedAgentEvent) => void;

export interface EventBusOptions {
  redisUrl?: string;
  disabled?: boolean;
}

export class EventBus {
  private readonly memory = new Map<string, SequencedAgentEvent[]>();
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private redis?: Redis;

  constructor(options: EventBusOptions = {}) {
    if (options.redisUrl && !options.disabled) {
      this.redis = new Redis(options.redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 1
      });
      this.redis.on("error", () => undefined);
    }
  }

  async connect(): Promise<void> {
    if (this.redis && this.redis.status === "wait") {
      await this.redis.connect();
    }
  }

  async ping(): Promise<void> {
    if (this.redis) {
      await this.connect();
      await this.redis.ping();
    }
  }

  async publish(record: RunEventRecord): Promise<void> {
    const item: SequencedAgentEvent = {
      seq: record.seq,
      event: record.payload,
      createdAt: record.createdAt
    };
    const list = this.memory.get(record.runId) ?? [];
    list.push(item);
    this.memory.set(record.runId, list);
    if (this.redis) {
      try {
        await this.connect();
        await this.redis.xadd(
          `stream:run:${record.runId}:events`,
          "*",
          "seq",
          String(record.seq),
          "event_type",
          record.eventType,
          "payload",
          JSON.stringify(record.payload),
          "created_at",
          record.createdAt
        );
      } catch {
        // Postgres is the durable source of truth. Redis stream outages should
        // not fail a run after the event has already been persisted.
      }
    }
    for (const subscriber of this.subscribers.get(record.runId) ?? []) {
      subscriber(item);
    }
  }

  async replay(runId: string): Promise<SequencedAgentEvent[]> {
    const redisEvents = await this.replayRedis(runId);
    const memoryEvents = this.memory.get(runId) ?? [];
    if (!redisEvents.length) {
      return [...memoryEvents].sort((a, b) => a.seq - b.seq);
    }
    const merged = new Map<number, SequencedAgentEvent>();
    for (const item of redisEvents) merged.set(item.seq, item);
    for (const item of memoryEvents) merged.set(item.seq, item);
    return [...merged.values()].sort((a, b) => a.seq - b.seq);
  }

  subscribe(runId: string, subscriber: Subscriber): () => void {
    const set = this.subscribers.get(runId) ?? new Set<Subscriber>();
    set.add(subscriber);
    this.subscribers.set(runId, set);
    return () => {
      set.delete(subscriber);
      if (!set.size) {
        this.subscribers.delete(runId);
      }
    };
  }

  private async replayRedis(runId: string): Promise<SequencedAgentEvent[]> {
    if (!this.redis) return [];
    try {
      await this.connect();
      const rows: Array<[string, string[]]> = await this.redis.xrange(`stream:run:${runId}:events`, "-", "+");
      return rows.map(([, values]: [string, string[]]) => {
        const map = toMap(values);
        return {
          seq: Number(map.seq),
          event: JSON.parse(map.payload) as AgentEvent,
          createdAt: map.created_at
        };
      });
    } catch {
      return [];
    }
  }
}

function toMap(values: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 2) {
    map[values[index]] = values[index + 1];
  }
  return map;
}
