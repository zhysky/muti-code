import type { TimelineEvent } from "../types.js";

export type ToolActivityStatus = "running" | "completed" | "failed" | "output-only";
export type ToolActivityKind = "tool" | "command" | "file" | "error";
export type RunEventFilter = "all" | "tools" | "commands" | "files" | "errors";

export interface ToolActivity {
  id: string;
  runId: string;
  kind: ToolActivityKind;
  name: string;
  label: string;
  status: ToolActivityStatus;
  count: number;
  seqStart: number;
  seqEnd: number;
  summary: string;
  input?: unknown;
  output?: unknown;
  events: TimelineEvent[];
  defaultOpen: boolean;
}

export interface RunEventCounts {
  total: number;
  tools: number;
  commands: number;
  files: number;
  errors: number;
}

export function buildToolActivities(events: TimelineEvent[], runId: string | null): ToolActivity[] {
  const items = filterRunEvents(events, runId, "all");
  const activities: ToolActivity[] = [];

  for (const event of items) {
    if (event.type === "tool.started") {
      activities.push(createToolActivity(event));
      continue;
    }

    if (event.type === "tool.completed") {
      const activity = findOpenToolActivity(activities, event.tool);
      if (activity) {
        activity.status = isFailureOutput(event.output) ? "failed" : "completed";
        activity.output = event.output;
        activity.summary = summarizeUnknown(event.output) || activity.summary;
        activity.seqEnd = event.seq;
        activity.events.push(event);
        activity.defaultOpen ||= activity.status === "failed";
      } else {
        activities.push(createToolOutputActivity(event));
      }
      continue;
    }

    if (event.type === "command.started") {
      activities.push(createCommandActivity(event));
      continue;
    }

    if (event.type === "command.completed") {
      const activity = findOpenCommandActivity(activities, event);
      if (activity) {
        activity.status = event.exitCode === 0 ? "completed" : "failed";
        activity.output = event.output;
        activity.summary = summarizeCommandCompleted(event);
        activity.seqEnd = event.seq;
        activity.events.push(event);
        activity.defaultOpen ||= activity.status === "failed";
      } else {
        activities.push(createCommandOutputActivity(event));
      }
      continue;
    }

    if (event.type === "file.changed") {
      activities.push({
        id: `${event.runId}-${event.seq}`,
        runId: event.runId,
        kind: "file",
        name: event.path,
        label: "文件变更",
        status: "completed",
        count: 1,
        seqStart: event.seq,
        seqEnd: event.seq,
        summary: event.path,
        output: event.diff,
        events: [event],
        defaultOpen: false
      });
      continue;
    }

    if (event.type === "run.failed" || event.type === "run.aborted") {
      activities.push({
        id: `${event.runId}-${event.seq}`,
        runId: event.runId,
        kind: "error",
        name: event.type,
        label: event.type === "run.failed" ? "运行失败" : "运行中止",
        status: "failed",
        count: 1,
        seqStart: event.seq,
        seqEnd: event.seq,
        summary: event.type === "run.failed" ? event.error : "Run aborted",
        output: event.type === "run.failed" ? event.error : undefined,
        events: [event],
        defaultOpen: true
      });
    }
  }

  return aggregateConsecutiveActivities(activities);
}

export function filterRunEvents(events: TimelineEvent[], runId: string | null, filter: RunEventFilter): TimelineEvent[] {
  if (!runId) return [];
  return events.filter((event) => event.runId === runId && matchesFilter(event, filter));
}

export function runEventSummary(events: TimelineEvent[], runId: string | null): RunEventCounts {
  const items = filterRunEvents(events, runId, "all");
  const stepItems = items.filter(isVisibleRunEvent);
  return {
    total: stepItems.length,
    tools: stepItems.filter(isToolEvent).length,
    commands: stepItems.filter(isCommandEvent).length,
    files: stepItems.filter((event) => event.type === "file.changed").length,
    errors: stepItems.filter(isErrorEvent).length
  };
}

export function activityStatusLabel(status: ToolActivityStatus): string {
  if (status === "running") return "运行中";
  if (status === "completed") return "完成";
  if (status === "failed") return "失败";
  return "仅输出";
}

export function formatActivityDetail(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function createToolActivity(event: Extract<TimelineEvent, { type: "tool.started" }>): ToolActivity {
  return {
    id: `${event.runId}-${event.seq}`,
    runId: event.runId,
    kind: "tool",
    name: event.tool,
    label: toolLabel(event.tool),
    status: "running",
    count: 1,
    seqStart: event.seq,
    seqEnd: event.seq,
    summary: event.tool,
    input: event.input,
    events: [event],
    defaultOpen: false
  };
}

function createToolOutputActivity(event: Extract<TimelineEvent, { type: "tool.completed" }>): ToolActivity {
  const failed = isFailureOutput(event.output);
  return {
    id: `${event.runId}-${event.seq}`,
    runId: event.runId,
    kind: "tool",
    name: event.tool,
    label: toolLabel(event.tool),
    status: failed ? "failed" : "output-only",
    count: 1,
    seqStart: event.seq,
    seqEnd: event.seq,
    summary: summarizeUnknown(event.output) || event.tool,
    output: event.output,
    events: [event],
    defaultOpen: failed
  };
}

function createCommandActivity(event: Extract<TimelineEvent, { type: "command.started" }>): ToolActivity {
  return {
    id: `${event.runId}-${event.seq}`,
    runId: event.runId,
    kind: "command",
    name: event.command,
    label: "命令执行",
    status: "running",
    count: 1,
    seqStart: event.seq,
    seqEnd: event.seq,
    summary: event.command,
    input: event.command,
    events: [event],
    defaultOpen: false
  };
}

function createCommandOutputActivity(event: Extract<TimelineEvent, { type: "command.completed" }>): ToolActivity {
  return {
    id: `${event.runId}-${event.seq}`,
    runId: event.runId,
    kind: "command",
    name: "command",
    label: "命令输出",
    status: event.exitCode === 0 ? "output-only" : "failed",
    count: 1,
    seqStart: event.seq,
    seqEnd: event.seq,
    summary: summarizeCommandCompleted(event),
    output: event.output,
    events: [event],
    defaultOpen: event.exitCode !== 0
  };
}

function aggregateConsecutiveActivities(activities: ToolActivity[]): ToolActivity[] {
  const aggregated: ToolActivity[] = [];
  for (const activity of activities) {
    const previous = aggregated.at(-1);
    if (previous && canAggregate(previous, activity)) {
      previous.count += activity.count;
      previous.seqEnd = activity.seqEnd;
      previous.events.push(...activity.events);
      previous.summary = `${activity.name} x${previous.count}`;
      continue;
    }
    aggregated.push({ ...activity, events: [...activity.events] });
  }
  return aggregated;
}

function canAggregate(left: ToolActivity, right: ToolActivity): boolean {
  return left.kind === right.kind
    && left.name === right.name
    && left.status === right.status
    && !left.defaultOpen
    && !right.defaultOpen;
}

function findOpenToolActivity(activities: ToolActivity[], tool: string): ToolActivity | undefined {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (activity.kind === "tool" && activity.name === tool && activity.status === "running") return activity;
  }
  return undefined;
}

function findOpenCommandActivity(
  activities: ToolActivity[],
  event: Extract<TimelineEvent, { type: "command.completed" }>
): ToolActivity | undefined {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (activity.kind === "command" && activity.status === "running") return activity;
  }
  return undefined;
}

function matchesFilter(event: TimelineEvent, filter: RunEventFilter): boolean {
  if (filter === "all") return true;
  if (filter === "tools") return isToolEvent(event);
  if (filter === "commands") return isCommandEvent(event);
  if (filter === "files") return event.type === "file.changed";
  return isErrorEvent(event);
}

function isVisibleRunEvent(event: TimelineEvent): boolean {
  return isToolEvent(event) || isCommandEvent(event) || event.type === "file.changed" || isErrorEvent(event);
}

function isToolEvent(event: TimelineEvent): boolean {
  return event.type === "tool.started" || event.type === "tool.completed";
}

function isCommandEvent(event: TimelineEvent): boolean {
  return event.type === "command.started" || event.type === "command.completed";
}

function isErrorEvent(event: TimelineEvent): boolean {
  return event.type === "run.failed" || event.type === "run.aborted";
}

function toolLabel(tool: string): string {
  const normalized = tool.toLowerCase();
  if (tool === "WebSearch" || normalized === "web_search") return "网页搜索";
  if (tool === "WebFetch" || normalized === "web_fetch") return "网页抓取";
  if (tool === "TaskCreate" || tool === "TaskUpdate" || normalized === "taskcreate" || normalized === "taskupdate") return "任务规划";
  if (tool === "Skill" || normalized.includes("skill")) return "技能调用";
  return "工具调用";
}

function summarizeCommandCompleted(event: Extract<TimelineEvent, { type: "command.completed" }>): string {
  const output = event.output?.trim();
  if (output) return `${event.exitCode}: ${truncate(output, 120)}`;
  return `exit ${event.exitCode}`;
}

function summarizeUnknown(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return truncate(value.trim(), 120);
  if (typeof value === "object" && "error" in value && typeof (value as { error?: unknown }).error === "string") {
    return truncate((value as { error: string }).error, 120);
  }
  return truncate(JSON.stringify(value), 120);
}

function isFailureOutput(output: unknown): boolean {
  if (!output) return false;
  if (typeof output === "string") return /\b(error|failed|permission denied|rate limited)\b/i.test(output);
  if (typeof output === "object" && "error" in output) return Boolean((output as { error?: unknown }).error);
  return false;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}...` : value;
}
