import type { Agent, AgentKind, Model, PermissionProfile, RuntimeStatus, Session } from "../types.js";

interface TopBarProps {
  agents: Agent[];
  models: Model[];
  session: Session | null;
  runtime: RuntimeStatus | null;
  agent: AgentKind;
  model: string;
  permission: PermissionProfile;
  runStatus: string;
  onOpenSidebar: () => void;
  onOpenDetails: () => void;
  onAgentChange: (agent: AgentKind) => void;
  onModelChange: (model: string) => void;
  onPermissionChange: (permission: PermissionProfile) => void;
  onApply: () => void;
  onAbort: () => void;
}

export function TopBar({
  agents,
  models,
  session,
  runtime,
  agent,
  model,
  permission,
  runStatus,
  onOpenSidebar,
  onOpenDetails,
  onAgentChange,
  onModelChange,
  onPermissionChange,
  onApply,
  onAbort
}: TopBarProps) {
  return (
    <header className="topBar">
      <button className="iconButton mobileOnly" type="button" onClick={onOpenSidebar} aria-label="Open sessions">=</button>
      <div className="sessionMeta">
        <strong>{session?.title || "New chat"}</strong>
        <span>{session?.id ?? "No session"}</span>
      </div>
      <div className="controlStrip">
        <label>
          <span>Agent</span>
          <select value={agent} onChange={(event) => onAgentChange(event.target.value as AgentKind)}>
            {agents.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <label>
          <span>Model</span>
          <select value={model} onChange={(event) => onModelChange(event.target.value)}>
            {models.map((item) => <option key={item.id} value={item.id}>{item.displayName ?? item.display_name ?? item.id}</option>)}
          </select>
        </label>
        <label>
          <span>Permission</span>
          <select value={permission} onChange={(event) => onPermissionChange(event.target.value as PermissionProfile)}>
            <option value="read-only">read-only</option>
            <option value="workspace-write">workspace-write</option>
          </select>
        </label>
        <button className="secondaryButton" type="button" onClick={onApply}>Apply</button>
      </div>
      <div className="topActions">
        <span className={runtime?.driver_mode === "mock" ? "statusPill warning" : "statusPill"}>
          {runtime?.driver_mode ?? "loading"}
        </span>
        <button className="secondaryButton" type="button" onClick={onOpenDetails}>Run details</button>
        <button className="dangerButton" type="button" onClick={onAbort} disabled={runStatus !== "running"}>Abort</button>
      </div>
    </header>
  );
}
