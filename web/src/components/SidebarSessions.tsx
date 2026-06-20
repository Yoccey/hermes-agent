/**
 * SidebarSessions — サイドバーに常時表示するセッション履歴リスト（desktop風）。
 *
 * `api.getSessions` で最近のセッションを取得し、検索フィルタ＋一覧を出す。
 * 項目クリックで `/chat?resume=<id>` に遷移して会話を再開する。
 * cron セッションは除外。アイコン折りたたみ時（collapsed）は非表示。
 */

import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Clock, Search } from "lucide-react";
import { api } from "@/lib/api";
import { useProfileScope } from "@/contexts/useProfileScope";
import { cn } from "@/lib/utils";

interface SessionEntry {
  id: string;
  title?: string;
  last_active?: number;
  source?: string;
}

interface SidebarSessionsProps {
  collapsed: boolean;
  closeMobile: () => void;
}

export function SidebarSessions({ collapsed, closeMobile }: SidebarSessionsProps) {
  const navigate = useNavigate();
  const { search: locSearch } = useLocation();
  const { profile } = useProfileScope();
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const [query, setQuery] = useState("");

  const load = useCallback(() => {
    api
      .getSessions(40)
      .then((r) => {
        // cron実行も含める（本家同様に内容を見られるように）。
        const list = ((r as { sessions?: SessionEntry[] }).sessions ?? [])
          .sort((a, b) => (b.last_active ?? 0) - (a.last_active ?? 0));
        setSessions(list);
      })
      .catch(() => {
        /* 取得失敗時は空のまま（バックエンド未接続のプレビュー等） */
      });
  }, []);

  // プロファイル切替時に取り直す。
  useEffect(() => {
    load();
  }, [load, profile]);

  // アイコンのみ表示のときはリストを出さない（幅が無い）。
  if (collapsed) return null;

  const q = query.trim().toLowerCase();
  const filtered = q
    ? sessions.filter((s) => (s.title ?? "").toLowerCase().includes(q))
    : sessions;
  const activeResume = new URLSearchParams(locSearch).get("resume");

  return (
    <div className="flex flex-col border-t border-current/10 pt-2">
      <div className="px-3 pb-2">
        <div className="flex items-center gap-1.5 rounded-md border border-current/15 bg-current/5 px-2 py-1">
          <Search className="h-3 w-3 shrink-0 text-text-tertiary" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="セッションを検索…"
            className="w-full min-w-0 bg-transparent text-xs text-text-secondary placeholder:text-text-tertiary focus:outline-none"
            aria-label="セッションを検索"
          />
        </div>
      </div>

      <span className="px-5 pb-1 font-mondwest text-display text-xs tracking-[0.12em] text-text-tertiary">
        セッション
      </span>

      <ul className="flex max-h-[45vh] flex-col overflow-y-auto overflow-x-hidden">
        {filtered.length === 0 ? (
          <li className="px-5 py-2 text-xs text-text-tertiary">
            {sessions.length === 0 ? "セッションなし" : "一致なし"}
          </li>
        ) : (
          filtered.map((s) => {
            const isCron = s.id.startsWith("cron_") || s.source === "cron";
            const label =
              s.title && s.title !== "Untitled"
                ? s.title
                : isCron
                  ? "CRON実行"
                  : "(無題)";
            const isActive = activeResume === s.id;
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => {
                    navigate(`/chat?resume=${encodeURIComponent(s.id)}`);
                    closeMobile();
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 px-5 py-1.5 text-left text-sm transition-colors cursor-pointer",
                    isActive
                      ? "text-midground"
                      : "text-text-secondary hover:text-midground",
                  )}
                  title={label}
                >
                  {isCron && (
                    <Clock className="h-3 w-3 shrink-0 text-text-tertiary" />
                  )}
                  <span className="truncate">{label}</span>
                </button>
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}
