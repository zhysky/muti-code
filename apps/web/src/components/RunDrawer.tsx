import type { RuntimeStatus, Session, TimelineEvent } from "../types.js";
import { runDiffFromEvents } from "../lib/run-details.js";

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
  const runEvents = runId ? events.filter((event) => event.runId === runId) : [];
  const runDiff = runDiffFromEvents(events, runId);

  return (
    <aside className={open ? "runDrawer open" : "runDrawer"} aria-label="Run details">
      <div className="drawerHeader">
        <div>
          <strong>Run details</strong>
          <span>{runId ?? "No active run"}</span>
        </div>
        <button className="iconButton" type="button" onClick={onClose} aria-label="Close run details">x</button>
      </div>
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

function TimelineItem({ event }: { event: TimelineEvent }) {
  return (
    <div className="timelineItem">
      <span>{event.seq}</span>
      <strong>{event.type}</strong>
      <p>{eventSummary(event)}</p>
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
  return event.runId;
}
