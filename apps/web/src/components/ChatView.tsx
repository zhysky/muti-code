import { productCopy } from "../lib/presentation.js";
import type { ChatMessage, Model, TimelineEvent } from "../types.js";
import { MarkdownContent } from "./MarkdownContent.js";

interface ChatViewProps {
  loading: boolean;
  messages: ChatMessage[];
  events: TimelineEvent[];
  prompt: string;
  model: string;
  models: Model[];
  running: boolean;
  disabled: boolean;
  onPromptChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onOpenDetails: () => void;
  onOpenRunDetails: (runId: string) => void;
  onAbort: () => void;
  onSubmit: () => void;
}

export function ChatView({
  loading,
  messages,
  events,
  prompt,
  model,
  models,
  running,
  disabled,
  onPromptChange,
  onModelChange,
  onOpenDetails,
  onOpenRunDetails,
  onAbort,
  onSubmit
}: ChatViewProps) {
  const hasMessages = messages.length > 0;
  return (
    <section className={hasMessages ? "chatPane hasMessages" : "chatPane emptyChat"}>
      <div className="messageScroller">
        {loading && <p className="emptyState">加载中...</p>}
        {!loading && !messages.length && (
          <div className="welcomePanel">
            <h1><span className="sparkIcon" aria-hidden="true">✦</span> {productCopy.emptyTitle}</h1>
            <p>{productCopy.emptyDescription}</p>
          </div>
        )}
        {messages.map((message) => (
          <MessageBubble
            key={message.id}
            message={message}
            events={events}
            onOpenRunDetails={onOpenRunDetails}
          />
        ))}
      </div>
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <textarea
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSubmit();
            }
          }}
          placeholder={productCopy.composerPlaceholder}
          rows={3}
        />
        <div className="composerFooter">
          <button className="attachButton" type="button" onClick={onOpenDetails} aria-label="Open run details">
            <span aria-hidden="true">+</span>
          </button>
          <div className="composerControls">
            <select className="composerModel" value={model} onChange={(event) => onModelChange(event.target.value)} aria-label="Model">
              {models.map((item) => (
                <option key={item.id} value={item.id}>{compactModelName(item)}</option>
              ))}
            </select>
            <button
              className={running ? "sendButton running" : "sendButton"}
              type={running ? "button" : "submit"}
              disabled={!running && (disabled || !prompt.trim())}
              onClick={running ? onAbort : undefined}
              aria-label={running ? "Abort run" : "Send message"}
            >
              {running ? <span className="spinner" aria-hidden="true" /> : "↑"}
            </button>
          </div>
        </div>
      </form>
    </section>
  );
}

function MessageBubble({
  message,
  events,
  onOpenRunDetails
}: {
  message: ChatMessage;
  events: TimelineEvent[];
  onOpenRunDetails: (runId: string) => void;
}) {
  const isUser = message.role === "user";
  const toolCount = message.runId
    ? events.filter((event) => event.runId === message.runId && (
      event.type === "tool.started"
      || event.type === "tool.completed"
      || event.type === "command.started"
      || event.type === "command.completed"
      || event.type === "file.changed"
    )).length
    : 0;
  return (
    <article className={isUser ? "messageBubble user" : "messageBubble assistant"}>
      {!isUser && toolCount > 0 && message.runId && (
        <button className="toolChip" type="button" onClick={() => message.runId && onOpenRunDetails(message.runId)}>
          <span aria-hidden="true">▸</span> 已执行 {toolCount} 个步骤
        </button>
      )}
      <div className="messageContent">
        {message.content
          ? isUser ? message.content : <MarkdownContent content={message.content} />
          : message.status === "streaming" ? <span className="typing">○ 思考中...</span> : null}
        {message.error && <p className="messageError">{message.error}</p>}
      </div>
    </article>
  );
}

function compactModelName(model: Model): string {
  const name = model.displayName ?? model.display_name ?? model.id;
  if (name.includes("MiniMax-M3")) return "MiniMax-M3";
  if (name.includes("GPT-5")) return "GPT-5 Codex";
  if (name.includes("Claude Sonnet")) return "Claude Sonnet";
  if (name.includes("OpenCode")) return name.replace("OpenCode + ", "");
  return name;
}
