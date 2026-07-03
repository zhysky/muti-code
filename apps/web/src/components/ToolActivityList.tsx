import React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  ClipboardList,
  ExternalLink,
  FileText,
  Globe,
  Search,
  Terminal,
  Wrench,
  XCircle
} from "lucide-react";
import {
  activityStatusLabel,
  formatActivityDetail,
  type ToolActivity
} from "../lib/tool-activity.js";

interface ToolActivityListProps {
  activities: ToolActivity[];
  runId: string;
  onOpenRunDetails: (runId: string) => void;
}

export function ToolActivityList({ activities, runId, onOpenRunDetails }: ToolActivityListProps) {
  if (!activities.length) return null;

  return (
    <div className="toolActivityList" aria-label="工具执行步骤">
      <div className="toolActivityListHeader">
        <span>步骤</span>
        <button className="inlineLogButton" type="button" onClick={() => onOpenRunDetails(runId)}>
          <ExternalLink size={13} aria-hidden="true" />
          完整日志
        </button>
      </div>
      <div className="toolActivityStack">
        {activities.map((activity) => (
          <ToolActivityCard key={activity.id} activity={activity} />
        ))}
      </div>
    </div>
  );
}

export function ToolActivityCard({ activity }: { activity: ToolActivity }) {
  const Icon = iconForActivity(activity);
  const input = formatActivityDetail(activity.input);
  const output = formatActivityDetail(activity.output);
  const rawEvents = formatActivityDetail(activity.events);

  return (
    <details className={`toolActivityCard ${activity.kind} ${activity.status}`} open={activity.defaultOpen}>
      <summary className="toolActivitySummary">
        <span className="toolActivityMain">
          <span className="toolActivityIcon" aria-hidden="true">
            <Icon size={14} />
          </span>
          <span className="toolActivityTitle">{activity.label}</span>
          <code>{activity.name}</code>
          {activity.count > 1 && <span className="toolActivityCount">x{activity.count}</span>}
        </span>
        <span className={`toolActivityStatus ${activity.status}`}>
          {statusIcon(activity.status)}
          {activityStatusLabel(activity.status)}
        </span>
        <span className="toolActivitySummaryText">{activity.summary}</span>
        <ChevronRight className="toolActivityChevron closed" size={14} aria-hidden="true" />
        <ChevronDown className="toolActivityChevron open" size={14} aria-hidden="true" />
      </summary>
      <div className="toolActivityDetails">
        {input && <ActivityDetail title="Tool input" value={input} />}
        {output && <ActivityDetail title={activity.status === "failed" ? "Error / output" : "Tool output"} value={output} />}
        <ActivityDetail title="Raw events" value={rawEvents} muted />
      </div>
    </details>
  );
}

function ActivityDetail({ title, value, muted = false }: { title: string; value: string; muted?: boolean }) {
  return (
    <div className={muted ? "activityDetail muted" : "activityDetail"}>
      <strong>{title}</strong>
      <pre>{value}</pre>
    </div>
  );
}

function iconForActivity(activity: ToolActivity) {
  if (activity.kind === "command") return Terminal;
  if (activity.kind === "file") return FileText;
  if (activity.kind === "error") return AlertTriangle;
  if (activity.name === "WebSearch" || activity.name.toLowerCase() === "web_search") return Search;
  if (activity.name === "WebFetch" || activity.name.toLowerCase() === "web_fetch") return Globe;
  if (activity.name === "TaskCreate" || activity.name === "TaskUpdate") return ClipboardList;
  return Wrench;
}

function statusIcon(status: ToolActivity["status"]) {
  if (status === "running") return <CircleDashed size={12} aria-hidden="true" />;
  if (status === "completed") return <CheckCircle2 size={12} aria-hidden="true" />;
  if (status === "failed") return <XCircle size={12} aria-hidden="true" />;
  return <Wrench size={12} aria-hidden="true" />;
}
