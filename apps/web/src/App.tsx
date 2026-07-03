import { useEffect, useMemo, useState } from "react";
import { api, streamMessage } from "./api.js";
import { ChatView } from "./components/ChatView.js";
import { RunDrawer } from "./components/RunDrawer.js";
import { Sidebar } from "./components/Sidebar.js";
import { defaultModelForAgent } from "./lib/presentation.js";
import { buildMessageStreamCurl, promptForRunDetails } from "./lib/run-details.js";
import { applyAssistantStreamEvent, createAssistantStreamMessage, mergePersistedChatMessages } from "./lib/stream-state.js";
import type { Agent, AgentKind, ChatMessage, Message, Model, PermissionProfile, RuntimeStatus, Session, TimelineEvent } from "./types.js";

const workspaceId = "sample-project";

export function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [runPrompts, setRunPrompts] = useState<Record<string, string>>({});
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [agent, setAgent] = useState<AgentKind>("claude");
  const [model, setModel] = useState("");
  const [permission, setPermission] = useState<PermissionProfile>("read-only");
  const [prompt, setPrompt] = useState("");
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [activeRunStatus, setActiveRunStatus] = useState<"idle" | "running" | "completed" | "failed" | "aborted">("idle");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [switchingAgent, setSwitchingAgent] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void loadInitial().catch((err: unknown) => setError(errorMessage(err))).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!agent) return;
    void loadModels(agent).catch((err: unknown) => setError(errorMessage(err)));
  }, [agent, agents]);

  async function loadInitial() {
    const [runtimeResponse, agentsResponse, sessionsResponse] = await Promise.all([
      api.getRuntime(),
      api.listAgents(),
      api.listSessions()
    ]);
    setRuntime(runtimeResponse);
    setAgents(agentsResponse.agents);
    const defaultAgent = agentsResponse.agents[0]?.id ?? "claude";
    const target = sessionsResponse.sessions[0] ?? await api.createSession({
      title: "New chat",
      agent: defaultAgent,
      model: agentsResponse.agents[0]?.default_model,
      workspace_id: workspaceId,
      permission_profile: "read-only"
    });
    setSessions(sessionsResponse.sessions[0] ? sessionsResponse.sessions : [target]);
    await selectSession(target);
  }

  async function loadModels(nextAgent: AgentKind) {
    const response = await api.listModels(nextAgent);
    setModels(response.models);
    setModel(defaultModelForAgent(nextAgent, agents, response.models, model));
  }

  async function selectSession(next: Session) {
    setSession(next);
    setAgent(next.defaultAgent);
    setModel(next.defaultModel);
    setPermission(next.permissionProfile);
    setEvents([]);
    setRunPrompts({});
    setActiveRunId(null);
    setActiveRunStatus("idle");
    setSidebarOpen(false);
    const messageResponse = await api.listMessages(next.id);
    const nextMessages = messageResponse.messages.map(toChatMessage);
    setMessages(nextMessages);
    await loadRunEventsForMessages(nextMessages, []);
  }

  async function createSession() {
    const created = await api.createSession({
      title: "New chat",
      agent,
      model: model || undefined,
      workspace_id: workspaceId,
      permission_profile: permission
    });
    setSessions((items) => [created, ...items.filter((item) => item.id !== created.id)]);
    await selectSession(created);
  }

  async function changeAgent(nextAgent: AgentKind) {
    if (nextAgent === agent || activeRunStatus === "running") return;
    setSwitchingAgent(true);
    setError("");
    try {
      const response = await api.listModels(nextAgent);
      const nextModel = defaultModelForAgent(nextAgent, agents, response.models, model);
      setAgent(nextAgent);
      setModels(response.models);
      setModel(nextModel);
      if (session && nextModel) {
        const updated = await api.switchAgent(session.id, { agent: nextAgent, model: nextModel });
        setSession(updated);
        setSessions((items) => items.map((item) => item.id === updated.id ? updated : item));
      }
    } finally {
      setSwitchingAgent(false);
    }
  }

  async function send() {
    if (!session || !prompt.trim() || !model || activeRunStatus === "running") return;
    const content = prompt.trim();
    const currentSession = session;
    setPrompt("");
    setError("");
    setDrawerOpen(false);
    setActiveRunStatus("running");
    setMessages((items) => [...items, {
      id: `user-${Date.now()}`,
      role: "user",
      content,
      agentKind: agent,
      model,
      createdAt: new Date().toISOString()
    }]);

    let assistantRunId = "";
    try {
      await streamMessage(currentSession.id, {
        content,
        agent,
        model,
        permission_profile: permission
      }, (event) => {
        assistantRunId = event.runId;
        setActiveRunId(event.runId);
        setRunPrompts((items) => items[event.runId] ? items : { ...items, [event.runId]: content });
        appendTimelineEvent(event);
        applyStreamEvent(event);
      });
      await refreshSessionData(currentSession);
    } catch (err) {
      const message = errorMessage(err);
      setError(message);
      setActiveRunStatus("failed");
      if (assistantRunId) {
        setMessages((items) => items.map((item) => item.runId === assistantRunId ? { ...item, status: "failed", error: message } : item));
      } else {
        setMessages((items) => [...items, {
          id: `assistant-error-${Date.now()}`,
          role: "assistant",
          content: "",
          status: "failed",
          error: message
        }]);
      }
    }
  }

  function appendTimelineEvent(event: TimelineEvent) {
    setEvents((items) => items.some((item) => item.runId === event.runId && item.seq === event.seq)
      ? items
      : [...items, event]);
  }

  function applyStreamEvent(event: TimelineEvent) {
    if (event.type === "run.failed") setActiveRunStatus("failed");
    if (event.type === "run.aborted") setActiveRunStatus("aborted");
    if (event.type === "run.completed") setActiveRunStatus("completed");
    if (event.type === "text.delta" || event.type === "message.completed" || event.type === "run.failed" || event.type === "run.aborted" || event.type === "run.completed") {
      setMessages((items) => {
        const index = items.findIndex((item) => item.runId === event.runId);
        if (index === -1) {
          return [...items, applyAssistantStreamEvent(createAssistantStreamMessage(event.runId), event)];
        }
        const next = [...items];
        next[index] = applyAssistantStreamEvent(next[index], event);
        return next;
      });
    }
  }

  async function refreshSessionData(target = session) {
    if (!target) return;
    const [messageResponse, sessionsResponse] = await Promise.all([
      api.listMessages(target.id),
      api.listSessions()
    ]);
    const persistedMessages = messageResponse.messages.map(toChatMessage);
    setMessages((current) => mergePersistedChatMessages(persistedMessages, current));
    await loadRunEventsForMessages(persistedMessages);
    setSessions(sessionsResponse.sessions);
    const latest = await api.getSession(target.id);
    setSession(latest);
    setAgent(latest.defaultAgent);
    setModel(latest.defaultModel);
    setPermission(latest.permissionProfile);
  }

  async function abort() {
    if (!activeRunId) return;
    await api.abortRun(activeRunId);
    setActiveRunStatus("aborted");
  }

  async function openRunDetails(runId: string) {
    setActiveRunId(runId);
    setDrawerOpen(true);
    if (events.some((event) => event.runId === runId)) return;
    const response = await api.listRunEvents(runId);
    setEvents((items) => mergeTimelineEvents(items, response.events));
  }

  async function loadRunEventsForMessages(nextMessages: ChatMessage[], knownEvents = events) {
    const knownRunIds = new Set(knownEvents.map((event) => event.runId));
    const runIds = Array.from(new Set(nextMessages
      .map((message) => message.runId)
      .filter((runId): runId is string => Boolean(runId) && !knownRunIds.has(runId))));
    if (!runIds.length) return;

    const responses = await Promise.all(runIds.map((runId) => api.listRunEvents(runId)));
    setEvents((items) => mergeTimelineEvents(items, responses.flatMap((response) => response.events)));
  }

  const curlExample = useMemo(() => {
    if (!session) return "";
    const content = promptForRunDetails(messages, runPrompts, activeRunId);
    if (!content) return "";
    return buildMessageStreamCurl({
      sessionId: session.id,
      agent,
      model,
      content
    });
  }, [session, messages, runPrompts, activeRunId, agent, model]);

  return (
    <main className="appShell">
      <Sidebar
        open={sidebarOpen}
        sessions={sessions}
        agents={agents}
        activeSessionId={session?.id ?? null}
        activeAgent={agent}
        switchingAgent={switchingAgent || activeRunStatus === "running"}
        onClose={() => setSidebarOpen(false)}
        onOpenDetails={() => setDrawerOpen(true)}
        onCreate={() => void createSession().catch((err: unknown) => setError(errorMessage(err)))}
        onAgentChange={(nextAgent) => void changeAgent(nextAgent).catch((err: unknown) => setError(errorMessage(err)))}
        onSelect={(next) => void selectSession(next).catch((err: unknown) => setError(errorMessage(err)))}
      />
      <section className="workspace">
        <button className="mobileMenuButton mobileOnly" type="button" onClick={() => setSidebarOpen(true)} aria-label="Open sessions">+</button>
        {error && <div className="errorBanner">{error}</div>}
        <ChatView
          loading={loading}
          messages={messages}
          events={events}
          prompt={prompt}
          model={model}
          models={models}
          running={activeRunStatus === "running"}
          disabled={!session || loading || activeRunStatus === "running"}
          onPromptChange={setPrompt}
          onModelChange={setModel}
          onOpenDetails={() => setDrawerOpen(true)}
          onOpenRunDetails={(runId) => {
            void openRunDetails(runId).catch((err: unknown) => setError(errorMessage(err)));
          }}
          onAbort={() => void abort().catch((err: unknown) => setError(errorMessage(err)))}
          onSubmit={() => void send()}
        />
      </section>
      <RunDrawer
        open={drawerOpen}
        events={events}
        runtime={runtime}
        session={session}
        runId={activeRunId}
        curlExample={curlExample}
        onClose={() => setDrawerOpen(false)}
      />
    </main>
  );
}

function toChatMessage(message: Message): ChatMessage {
  return {
    id: message.id,
    role: message.role === "assistant" || message.role === "system" ? message.role : "user",
    content: message.content ?? "",
    agentKind: message.agentKind,
    model: message.model,
    runId: message.runId,
    createdAt: message.createdAt,
    status: message.role === "assistant" ? "completed" : undefined
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mergeTimelineEvents(current: TimelineEvent[], incoming: TimelineEvent[]): TimelineEvent[] {
  const seen = new Set(current.map((event) => `${event.runId}:${event.seq}`));
  const merged = [...current];
  for (const event of incoming) {
    const key = `${event.runId}:${event.seq}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(event);
  }
  return merged.sort((left, right) => left.seq - right.seq);
}
