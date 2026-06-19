/**
 * ChatPage — Clean chat UI using the Gateway JSON-RPC WebSocket API.
 *
 * Replaces the previous xterm/PTY-based terminal embed with a standard
 * message-bubble layout (user right, assistant left) similar to Claude/OpenWebUI.
 * Connects via GatewayClient: session.create → prompt.submit → message.delta events.
 */

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Plus, SendHorizonal, Square, Wrench, X } from "lucide-react";
import { Button } from "@nous-research/ui/ui/components/button";
import { cn } from "@/lib/utils";
import { Markdown } from "@/components/Markdown";
import { ChatSidebar } from "@/components/ChatSidebar";
import { SessionHistoryPanel } from "@/components/SessionHistoryPanel";
import { usePageHeader } from "@/contexts/usePageHeader";
import { useProfileScope } from "@/contexts/useProfileScope";
import { GatewayClient } from "@/lib/gatewayClient";
import { api } from "@/lib/api";
import { PluginSlot } from "@/plugins";

// ─── Types ───────────────────────────────────────────────────────────────────

type Role = "user" | "assistant";

interface ToolCall {
  name: string;
  status: "running" | "done" | "error";
  summary?: string;
}

interface Message {
  id: string;
  role: Role;
  text: string;
  streaming?: boolean;
  toolCalls?: ToolCall[];
  statusText?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function genId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

// ─── Tool call badge ──────────────────────────────────────────────────────────

function ToolBadge({ tool }: { tool: ToolCall }) {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-1.5 text-xs font-mono",
        tool.status === "running"
          ? "text-primary/80"
          : tool.status === "error"
            ? "text-destructive/80"
            : "text-muted-foreground/80",
      )}
    >
      <Wrench size={11} className={tool.status === "running" ? "animate-spin" : ""} />
      <span>{tool.name}</span>
      {tool.summary && (
        <span className="text-muted-foreground/50 truncate max-w-[220px]">
          — {tool.summary}
        </span>
      )}
    </div>
  );
}

// ─── Single message bubble ────────────────────────────────────────────────────

const MessageBubble = memo(function MessageBubble({ msg }: { msg: Message }) {
  const isUser = msg.role === "user";

  // ユーザー発言のみ控えめな soft fill のバブル（右寄せ）。
  if (isUser) {
    return (
      <div className="flex w-full justify-end">
        <div className="max-w-[85%] sm:max-w-[70%] rounded-2xl bg-secondary/60 px-4 py-2.5 text-sm text-foreground">
          <p className="whitespace-pre-wrap leading-relaxed">{msg.text}</p>
        </div>
      </div>
    );
  }

  // アシスタント発言は脱・箱化：背景も枠も持たず、本文がページに直接流れる（desktop風 flat）。
  // 余白（親の space-y）でターンを区切る。
  return (
    <div className="w-full text-sm text-foreground">
      {msg.statusText && (
        <p className="text-xs text-muted-foreground italic mb-1.5">{msg.statusText}</p>
      )}
      {msg.toolCalls && msg.toolCalls.length > 0 && (
        <div className="flex flex-col gap-1 mb-2">
          {msg.toolCalls.map((t, i) => <ToolBadge key={i} tool={t} />)}
        </div>
      )}
      {msg.text ? (
        <Markdown content={msg.text} streaming={msg.streaming} />
      ) : msg.streaming ? (
        <span className="inline-block w-2 h-4 bg-foreground/40 animate-pulse rounded-sm" />
      ) : null}
    </div>
  );
});

// ─── Main ChatPage ────────────────────────────────────────────────────────────

export default function ChatPage(_props: { isActive?: boolean } = {}) {
  const { profile } = useProfileScope();
  const { setTitle } = usePageHeader();
  const [searchParams] = useSearchParams();
  const resumeSession = searchParams.get("resume");

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [channelId] = useState(genId);
  const [historyOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  const gwRef = useRef<GatewayClient | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // message.delta を requestAnimationFrame で間引くためのバッファ。
  const pendingDeltaRef = useRef("");
  const rafRef = useRef<number | null>(null);

  useEffect(() => { setTitle("チャット"); }, [setTitle]);

  useEffect(() => {
    const c = scrollRef.current;
    if (!c) return;
    // 最下部付近のときだけ即時スクロール（アニメ無し）。
    // トークン毎の smooth scroll が毎フレーム reflow を起こしメインスレッドを飽和させるのを防ぐ。
    if (c.scrollHeight - c.scrollTop - c.clientHeight < 120) {
      c.scrollTop = c.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  // バッファした delta テキストをまとめて1回の setState で反映する。
  // 35トークン/秒の setState を毎フレーム1回に間引き、再描画回数を抑える。
  const flushDelta = useCallback(() => {
    rafRef.current = null;
    const chunk = pendingDeltaRef.current;
    if (!chunk) return;
    pendingDeltaRef.current = "";
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === "assistant" && last.streaming) {
        return [...prev.slice(0, -1), { ...last, text: last.text + chunk }];
      }
      return [...prev, { id: genId(), role: "assistant", text: chunk, streaming: true }];
    });
  }, []);

  const connect = useCallback(async () => {
    gwRef.current?.close();
    const gw = new GatewayClient();
    gwRef.current = gw;
    gw.onState((s) => setConnected(s === "open"));

    try {
      await gw.connect();
    } catch { return; }

    // 直近の対話セッションを継続（URL ?resume= が無ければ最新の非cronセッションを採用）。
    // tui_auto_resume_recent 相当の挙動をバブルUIで再現する。
    let resumeId: string | null = resumeSession;
    if (!resumeId) {
      try {
        const list = await api.getSessions(20);
        const recent = [...(list.sessions ?? [])]
          .sort((a, b) => b.last_active - a.last_active)
          .find((s) => !s.id.startsWith("cron_") && s.source !== "cron");
        resumeId = recent?.id ?? null;
      } catch { resumeId = null; }
    }

    const result = await gw.request<{ session_id: string }>("session.create", {
      channel: channelId,
      ...(profile ? { profile } : {}),
      ...(resumeId ? { resume: resumeId } : {}),
    });
    setSessionId(result.session_id);

    // 継続したセッションの全履歴をバブルで表示する（resume_display: full 相当）。
    if (resumeId) {
      try {
        const hist = await api.getSessionMessages(resumeId);
        const loaded: Message[] = hist.messages
          .filter((m) => (m.role === "user" || m.role === "assistant") && m.content)
          .map((m) => ({ id: genId(), role: m.role as Role, text: m.content as string }));
        if (loaded.length) setMessages(loaded);
      } catch { /* 履歴取得失敗時は空のまま */ }
    }

    gw.on<{ text?: string }>("message.delta", (ev) => {
      pendingDeltaRef.current += ev.payload?.text ?? "";
      if (rafRef.current === null) rafRef.current = requestAnimationFrame(flushDelta);
    });

    gw.on("message.complete", () => {
      flushDelta(); // バッファ残りを確定してから完了処理
      setStreaming(false);
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant") return [...prev.slice(0, -1), { ...last, streaming: false }];
        return prev;
      });
    });

    gw.on<{ text?: string }>("status.update", (ev) => {
      flushDelta();
      const text = ev.payload?.text ?? "";
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant" && last.streaming)
          return [...prev.slice(0, -1), { ...last, statusText: text }];
        return prev;
      });
    });

    gw.on<{ name?: string }>("tool.start", (ev) => {
      flushDelta();
      const name = ev.payload?.name ?? "tool";
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        const newTool = { name, status: "running" as const };
        if (last?.role === "assistant" && last.streaming) {
          return [...prev.slice(0, -1), { ...last, toolCalls: [...(last.toolCalls ?? []), newTool], statusText: undefined }];
        }
        return [...prev, { id: genId(), role: "assistant", text: "", streaming: true, toolCalls: [newTool] }];
      });
    });

    gw.on<{ name?: string; summary?: string }>("tool.complete", (ev) => {
      flushDelta();
      const { name = "", summary = "" } = ev.payload ?? {};
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant") {
          const toolCalls = (last.toolCalls ?? []).map((t) =>
            t.name === name && t.status === "running" ? { ...t, status: "done" as const, summary } : t,
          );
          return [...prev.slice(0, -1), { ...last, toolCalls }];
        }
        return prev;
      });
    });
  }, [channelId, profile, resumeSession, flushDelta]);

  useEffect(() => {
    connect();
    return () => {
      gwRef.current?.close();
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [connect]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || !sessionId || !gwRef.current || streaming) return;
    setInput("");
    setStreaming(true);
    setMessages((prev) => [...prev, { id: genId(), role: "user", text }]);
    try {
      await gwRef.current.request("prompt.submit", { session_id: sessionId, text });
    } catch { setStreaming(false); }
  }, [input, sessionId, streaming]);

  const stopGeneration = useCallback(async () => {
    if (!sessionId || !gwRef.current) return;
    try { await gwRef.current.request("session.interrupt", { session_id: sessionId }); } catch { /* ignore */ }
    setStreaming(false);
  }, [sessionId]);

  const newChat = useCallback(async () => {
    if (streaming) return;
    setMessages([]);
    setInput("");
    const gw = gwRef.current;
    if (!gw) { connect(); return; }
    try {
      const result = await gw.request<{ session_id: string }>("session.create", {
        channel: channelId,
        ...(profile ? { profile } : {}),
      });
      setSessionId(result.session_id);
    } catch { connect(); }
  }, [channelId, profile, streaming, connect]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="flex h-full overflow-hidden">

      {/* サイドバー：デスクトップは常時表示、モバイルはオーバーレイ */}
      <div className={cn(
        "hidden lg:flex lg:h-full lg:w-80 lg:shrink-0",
      )}>
        <ChatSidebar channel={channelId} />
      </div>

      {/* モバイルサイドバー：オーバーレイ */}
      {mobileSidebarOpen && (
        <div className="lg:hidden fixed inset-0 z-50 flex flex-col bg-background/95 backdrop-blur-sm p-4 gap-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-muted-foreground">モデル・ツール</span>
            <Button size="icon" ghost className="h-8 w-8" onClick={() => setMobileSidebarOpen(false)}>
              <X size={16} />
            </Button>
          </div>
          <ChatSidebar channel={channelId} />
        </div>
      )}

      <div className="flex flex-col flex-1 min-w-0 h-full">
        {!connected && (
          <div className="flex items-center justify-between px-4 py-2 bg-destructive/10 border-b border-destructive/20 text-xs text-destructive">
            <span>接続が切れています</span>
            <button className="underline hover:no-underline" onClick={connect}>再接続</button>
          </div>
        )}

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 sm:px-4 py-4 sm:py-6 space-y-4">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center gap-4 pb-24 select-none">
              <h1
                className="text-4xl sm:text-6xl font-semibold uppercase tracking-[0.1em] text-foreground/90"
                style={{ fontFamily: "var(--theme-font-display)" }}
              >
                Hermes Agent
              </h1>
              <p className="text-sm text-muted-foreground/70 max-w-md leading-relaxed">
                スキル・ツール・CRON・MCPを備えた軍師にメッセージを送ってください
              </p>
            </div>
          )}
          {messages.map((msg) => <MessageBubble key={msg.id} msg={msg} />)}
        </div>

        <div className="bg-background px-3 sm:px-4 py-3 safe-area-pb">
          {/* desktop の "Send follow-up" 風：丸いピル1本に + / 入力 / 送信 を収める */}
          <div className="flex items-end gap-1.5 max-w-3xl mx-auto rounded-[1.75rem] border border-border/40 bg-secondary/40 px-2 py-1.5 transition-colors focus-within:border-primary/30 focus-within:bg-secondary/55">
            {/* 新規チャット */}
            <Button
              size="icon"
              ghost
              className="shrink-0 h-9 w-9 rounded-full"
              onClick={newChat}
              disabled={!connected || streaming}
              title="新規チャット（現在の会話をリセット）"
            >
              <Plus size={18} />
            </Button>
            {/* モバイル：サイドバートグルボタン */}
            <Button
              size="icon"
              ghost
              className="lg:hidden shrink-0 h-9 w-9 rounded-full"
              onClick={() => setMobileSidebarOpen(true)}
              title="モデル情報"
            >
              <Wrench size={15} />
            </Button>

            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                connected
                  ? "メッセージを入力… (Cmd+Enter で送信)"
                  : "接続中…"
              }
              disabled={!connected || !sessionId}
              rows={1}
              className={cn(
                "flex-1 resize-none self-center bg-transparent border-0",
                "px-2 py-2 text-sm leading-relaxed",
                "placeholder:text-muted-foreground/50",
                "focus:outline-none focus:ring-0",
                "disabled:opacity-40 disabled:cursor-not-allowed",
              )}
              style={{ maxHeight: "200px", overflowY: "auto" }}
            />
            {streaming ? (
              <Button size="icon" destructive className="rounded-full shrink-0 h-9 w-9" onClick={stopGeneration} title="停止">
                <Square size={15} />
              </Button>
            ) : (
              <Button size="icon" className="rounded-full shrink-0 h-9 w-9" onClick={sendMessage} disabled={!connected || !sessionId || !input.trim()} title="送信 (Cmd+Enter)">
                <SendHorizonal size={15} />
              </Button>
            )}
          </div>
        </div>
      </div>

      <PluginSlot name="chat.panel.right" />
      {historyOpen && sessionId && <SessionHistoryPanel sessionId={sessionId} />}
    </div>
  );
}
