import { ArrowUp, Plus } from "lucide-react";
import React, { useEffect, useRef } from "react";
import { buildToolActivities } from "../lib/tool-activity.js";
import { productCopy } from "../lib/presentation.js";
import type { ChatMessage, Model, TimelineEvent } from "../types.js";
import { MarkdownContent } from "./MarkdownContent.js";
import { ToolActivityList } from "./ToolActivityList.js";

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
  const scrollerRef = useRef<HTMLDivElement>(null);
  const latestMessage = messages[messages.length - 1];

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
  }, [events.length, latestMessage?.content, latestMessage?.status, messages.length]);

  return (
    <section className={hasMessages ? "chatPane hasMessages" : "chatPane emptyChat"}>
      <div className="messageScroller" ref={scrollerRef}>
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
            <Plus size={16} aria-hidden="true" />
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
              {running ? <span className="spinner" aria-hidden="true" /> : <ArrowUp size={18} aria-hidden="true" />}
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
  const activities = !isUser && message.runId ? buildToolActivities(events, message.runId) : [];
  return (
    <article className={isUser ? "messageBubble user" : "messageBubble assistant"}>
      {!isUser && message.runId && (
        <ToolActivityList
          activities={activities}
          runId={message.runId}
          onOpenRunDetails={onOpenRunDetails}
        />
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
