/**
 * SessionHistoryPanel — shows previous conversation messages when resuming a
 * session, rendered as chat bubbles so the user can immediately see context.
 * Only mounts when a `resumeParam` (session id) is supplied.
 */

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { SessionMessage } from "@/lib/api";
import { Markdown } from "@/components/Markdown";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronUp, History } from "lucide-react";
import { Button } from "@nous-research/ui/ui/components/button";

interface Props {
  sessionId: string;
}

const PREVIEW_COUNT = 6; // user+assistant pairs visible without expanding

function isContentful(msg: SessionMessage): boolean {
  if (msg.role === "system") return false;
  if (msg.role === "tool") return false;
  if (!msg.content) return false;
  return true;
}

function MessageBubble({ msg }: { msg: SessionMessage }) {
  const isUser = msg.role === "user";

  return (
    <div
      className={cn(
        "flex gap-2 px-1",
        isUser ? "flex-row-reverse" : "flex-row",
      )}
    >
      <div
        className={cn(
          "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold",
          isUser
            ? "bg-midground/20 text-midground"
            : "bg-primary/20 text-primary",
        )}
      >
        {isUser ? "U" : "A"}
      </div>

      <div
        className={cn(
          "max-w-[80%] rounded-lg px-3 py-2 text-xs leading-relaxed",
          isUser
            ? "bg-midground/10 text-text-primary rounded-tr-none"
            : "bg-background-surface/60 text-text-primary rounded-tl-none border border-current/10",
        )}
      >
        <Markdown content={msg.content ?? ""} />
      </div>
    </div>
  );
}

export function SessionHistoryPanel({ sessionId }: Props) {
  const [messages, setMessages] = useState<SessionMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .getSessionMessages(sessionId)
      .then((res) => {
        if (cancelled) return;
        setMessages(res.messages.filter(isContentful));
      })
      .catch(() => {
        if (!cancelled) setMessages([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "instant" });
  }, [messages, expanded]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-xs text-text-tertiary">
        <History className="h-3 w-3 animate-pulse" />
        Loading history…
      </div>
    );
  }

  if (messages.length === 0) return null;

  const visible = expanded ? messages : messages.slice(-PREVIEW_COUNT);
  const hidden = messages.length - visible.length;

  return (
    <div
      className={cn(
        "flex flex-col gap-2 overflow-y-auto rounded-lg border border-current/10",
        "bg-background-base/40 backdrop-blur-sm px-3 py-3",
        "max-h-[40vh] shrink-0",
      )}
    >
      {/* header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[10px] font-mondwest tracking-widest text-text-tertiary uppercase">
          <History className="h-3 w-3" />
          Resumed · {messages.length} messages
        </div>
        {messages.length > PREVIEW_COUNT && (
          <Button
            ghost
            size="icon"
            onClick={() => setExpanded((p) => !p)}
            className="h-5 w-5 text-text-tertiary hover:text-midground"
          >
            {expanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronUp className="h-3 w-3" />
            )}
          </Button>
        )}
      </div>

      {/* truncation notice */}
      {!expanded && hidden > 0 && (
        <button
          onClick={() => setExpanded(true)}
          className="text-center text-[10px] text-text-tertiary hover:text-midground transition-colors"
        >
          ↑ {hidden} earlier messages — click to expand
        </button>
      )}

      {/* messages */}
      <div className="flex flex-col gap-2">
        {visible.map((msg, i) => (
          <MessageBubble key={i} msg={msg} />
        ))}
      </div>

      <div ref={bottomRef} />
    </div>
  );
}
