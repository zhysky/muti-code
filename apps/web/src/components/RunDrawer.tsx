import { AlertTriangle, FileText, Terminal, Wrench, X } from "lucide-react";
import React, { useState } from "react";
import type { RuntimeStatus, Session, TimelineEvent } from "../types.js";
import { runDiffFromEvents } from "../lib/run-details.js";
import {
  filterRunEvents,
  formatActivityDetail,
  runEventSummary,
  type RunEventFilter
} from "../lib/tool-activity.js";

interface RunDrawerProps {
  open: boolean;
  events: TimelineEvent[];
  runtime: RuntimeStatus | null;
  session: Session | null;
  runId: string | null;
  curlExample: string;
  onClose: () => void;
}

export function RunDrawer({ open, events, runtime, session, runId, curlExample, onClose }: RunDrawerProps) {
  const [filter, setFilter] = useState<RunEventFilter>("all");
  const runEvents = filterRunEvents(events, runId, filter);
  const summary = runEventSummary(events, runId);
  const runDiff = runDiffFromEvents(events, runId);

  return (
    <aside className={open ? "runDrawer open" : "runDrawer"} aria-label="Run details">
      <div className="drawerHeader">
        <div>
          <strong>Run details</strong>
          <span>{runId ?? "No active run"}</span>
        </div>
        <button className="iconButton" type="button" onClick={onClose} aria-label="Close run details">
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <section className="drawerSection">
        <h2>Overview</h2>
        <div className="runSummaryGrid">
          <SummaryStat label="总步数" value={summary.total} />
          <SummaryStat label="工具调用" value={summary.tools} />
          <SummaryStat label="失败" value={summary.errors} tone={summary.errors ? "danger" : undefined} />
          <SummaryStat label="文件变更" value={summary.files} />
        </div>
      </section>
      <section className="drawerSection">
        <h2>Runtime</h2>
        <dl className="metaGrid">
          <dt>Driver</dt>
          <dd>{runtime?.driver_mode ?? "-"}</dd>
          <dt>Storage</dt>
          <dd>{runtime?.storage ?? "-"}</dd>
          <dt>MiniMax</dt>
          <dd>{runtime?.minimax_ready ? "ready" : "missing"}</dd>
          <dt>Session</dt>
          <dd>{session?.id ?? "-"}</dd>
        </dl>
      </section>
      <section className="drawerSection">
        <h2>Timeline</h2>
        <RunEventFilters value={filter} onChange={setFilter} />
        <div className="timeline">
          {runEvents.map((event) => <TimelineItem key={`${event.runId}-${event.seq}`} event={event} />)}
          {!runEvents.length && <p className="emptyState">No run events yet</p>}
        </div>
      </section>
      <section className="drawerSection">
        <h2>Run diff</h2>
        <pre>{runDiff || "No file changes for this run"}</pre>
      </section>
      <section className="drawerSection">
        <h2>HTTP request</h2>
        <pre>{curlExample || "Create or select a session first"}</pre>
      </section>
    </aside>
  );
}

function SummaryStat({ label, value, tone }: { label: string; value: number; tone?: "danger" }) {
  return (
    <div className={tone ? `runSummaryItem ${tone}` : "runSummaryItem"}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

export function RunEventFilters({
  value,
  onChange
}: {
  value: RunEventFilter;
  onChange: (value: RunEventFilter) => void;
}) {
  const filters: Array<{ value: RunEventFilter; label: string }> = [
    { value: "all", label: "All" },
    { value: "tools", label: "Tools" },
    { value: "commands", label: "Commands" },
    { value: "files", label: "Files" },
    { value: "errors", label: "Errors" }
  ];

  return (
    <div className="runEventFilters" aria-label="Filter run events">
      {filters.map((item) => (
        <button
          key={item.value}
          className={value === item.value ? "active" : ""}
          type="button"
          onClick={() => onChange(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function TimelineItem({ event }: { event: TimelineEvent }) {
  return (
    <div className={`timelineItem ${eventKind(event)}`}>
      <span className="timelineSeq">{event.seq}</span>
      <span className="timelineIcon" aria-hidden="true">{eventIcon(event)}</span>
      <div className="timelineBody">
        <div className="timelineTitleRow">
          <strong>{event.type}</strong>
          <span>{eventKindLabel(event)}</span>
        </div>
        <p>{eventSummary(event)}</p>
        <details className="rawEvent">
          <summary>Raw event</summary>
          <pre>{formatActivityDetail(event)}</pre>
        </details>
      </div>
    </div>
  );
}

function eventSummary(event: TimelineEvent): string {
  if (event.type === "text.delta" || event.type === "message.completed") return event.text;
  if (event.type === "tool.started" || event.type === "tool.completed") return event.tool;
  if (event.type === "command.started") return event.command;
  if (event.type === "command.completed") return `${event.exitCode}: ${event.output ?? ""}`;
  if (event.type === "file.changed") return event.path;
  if (event.type === "run.failed") return event.error;
  if (event.type === "run.completed") return "Run completed";
  if (event.type === "run.started") return "Run started";
  if (event.type === "run.aborted") return "Run aborted";
  return event.runId;
}

function eventKind(event: TimelineEvent): RunEventFilter {
  if (event.type === "tool.started" || event.type === "tool.completed") return "tools";
  if (event.type === "command.started" || event.type === "command.completed") return "commands";
  if (event.type === "file.changed") return "files";
  if (event.type === "run.failed" || event.type === "run.aborted") return "errors";
  return "all";
}

function eventKindLabel(event: TimelineEvent): string {
  const kind = eventKind(event);
  if (kind === "tools") return "Tool";
  if (kind === "commands") return "Command";
  if (kind === "files") return "File";
  if (kind === "errors") return "Error";
  return "Run";
}

function eventIcon(event: TimelineEvent) {
  const kind = eventKind(event);
  if (kind === "commands") return <Terminal size={13} />;
  if (kind === "files") return <FileText size={13} />;
  if (kind === "errors") return <AlertTriangle size={13} />;
  if (kind === "tools") return <Wrench size={13} />;
  return <Wrench size={13} />;
}
