import { agentDisplayName, productCopy } from "../lib/presentation.js";
import type { Agent, AgentKind, Session } from "../types.js";

interface SidebarProps {
  open: boolean;
  sessions: Session[];
  agents: Agent[];
  activeSessionId: string | null;
  activeAgent: AgentKind;
  switchingAgent: boolean;
  onClose: () => void;
  onOpenDetails: () => void;
  onCreate: () => void;
  onAgentChange: (agent: AgentKind) => void;
  onSelect: (session: Session) => void;
}

export function Sidebar({
  open,
  sessions,
  agents,
  activeSessionId,
  activeAgent,
  switchingAgent,
  onClose,
  onOpenDetails,
  onCreate,
  onAgentChange,
  onSelect
}: SidebarProps) {
  return (
    <>
      <aside className={open ? "sidebar open" : "sidebar"}>
        <div className="sidebarHeader">
          <strong>{productCopy.brand}</strong>
          <button className="iconButton mobileOnly" type="button" onClick={onClose} aria-label="Close sessions">x</button>
        </div>
        <button className="newChatButton" type="button" onClick={onCreate}><span>+</span> {productCopy.newSession}</button>
        <nav className="sessionNav" aria-label="Sessions">
          <div className="sessionGroupLabel">{sessions.length ? productCopy.recentSessions : ""}</div>
          {sessions.map((session) => (
            <button
              className={session.id === activeSessionId ? "sessionButton active" : "sessionButton"}
              key={session.id}
              type="button"
              onClick={() => onSelect(session)}
            >
              <span>{displaySessionTitle(session)}</span>
            </button>
          ))}
          {!sessions.length && <p className="emptyState sidebarEmpty">{productCopy.emptySession}</p>}
        </nav>
        <footer className="sidebarFooter">
          <label className="agentSwitch">
            <span>Agent 底座</span>
            <select
              value={activeAgent}
              disabled={switchingAgent}
              onChange={(event) => onAgentChange(event.target.value as AgentKind)}
              aria-label="Agent 底座"
            >
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>{agentDisplayName(agent.id)}</option>
              ))}
            </select>
          </label>
          <button className="moonButton" type="button" onClick={onOpenDetails} aria-label="Open run details">○</button>
        </footer>
      </aside>
      {open && <button className="sidebarScrim mobileOnly" type="button" aria-label="Close sessions" onClick={onClose} />}
    </>
  );
}

function displaySessionTitle(session: Session): string {
  if (!session.title || session.title === "New chat") return productCopy.newSession;
  return session.title;
}
