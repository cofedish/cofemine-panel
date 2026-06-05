"use client";
import { useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";

/**
 * Dedicated chat panel — same WebSocket the console uses, but
 * filtered down to in-game chat / join-leave / death lines and
 * rendered with player heads. The console tab keeps the raw firehose
 * for ops who need to see startup / stack traces; this is the
 * "talk to your server" view.
 *
 * Pattern-matched against the vanilla server log format:
 *
 * Real log lines we have to handle (paper, forge, neoforge all
 * have slight variations — and itzg's stdout is decorated with
 * ANSI colour escapes that we have to strip first):
 *
 *   [16:39:50] [Server thread/INFO]: <Player> hi                       (vanilla / paper)
 *   [16:39:50] [Server thread/INFO] [minecraft/PlayerList]: <Player> hi (forge / neoforge)
 *   [16:39:50] [Server thread/INFO] [minecraft/DedicatedServer]: Player joined the game
 *   [16:39:50] [Server thread/INFO] [minecraft/DedicatedServer]: Player was slain by Zombie
 *
 * The regexes here don't anchor on `[Server thread/INFO]:` directly —
 * instead they peel ANSI off, then look for `:` followed by `<Name>`
 * or `Name <verb>`. That tolerates any number of mod-decorated
 * `[logger/name]` brackets between the thread tag and the colon.
 */

type ChatMsg =
  | { kind: "say"; ts: number; player: string; text: string }
  | { kind: "join"; ts: number; player: string }
  | { kind: "leave"; ts: number; player: string }
  | { kind: "death"; ts: number; player: string; text: string }
  | { kind: "system"; ts: number; text: string };

// ANSI/colour escapes (itzg's runner pipes minecraft's coloured
// stdout through with the escapes intact). Strip before regex
// matching so [33m doesn't break the <Name> capture.
const ANSI_RE = /\x1b\[[0-9;]*m/g;

// All of these match anywhere AFTER a `]:` so leading mod loggers
// don't break us. (?:^|]:\s*) — line start or any `]:` followed by
// whitespace — lets us catch both vanilla single-bracket and
// forge multi-bracket lines.
const CHAT_SAY = /(?:^|]:\s*)<([A-Za-z0-9_]{2,16})>\s+(.+?)\s*$/;
const CHAT_JOIN = /(?:^|]:\s*)([A-Za-z0-9_]{2,16})\s+joined the game\s*$/;
const CHAT_LEAVE = /(?:^|]:\s*)([A-Za-z0-9_]{2,16})\s+left the game\s*$/;
// Death verb list per the vanilla DeathMessages table — the first
// word that immediately follows the player's name in 99% of death
// messages. Catches enough for the panel; missing edge cases just
// fall through to console.
const DEATH_VERBS =
  "was|fell|drowned|hit|tried|burned|got|went|withered|froze|starved|suffocated|walked|blew|experienced|didn|swam|fired|drove|impaled|squashed|discovered|stepped|hugged|pummeled|slipped|died";
const CHAT_DEATH = new RegExp(
  `(?:^|]:\\s*)([A-Za-z0-9_]{2,16})\\s+((?:${DEATH_VERBS})\\b.+?)\\s*$`
);

function parseChat(raw: string): ChatMsg | null {
  const line = raw.replace(ANSI_RE, "");
  // Drop the "[Player: did something]" echo lines — those are the
  // server's confirmation of an op's command, not real chat.
  if (/]:\s*\[[A-Za-z0-9_]+:\s/.test(line)) return null;
  const now = Date.now();
  const m1 = CHAT_SAY.exec(line);
  if (m1) {
    return { kind: "say", ts: now, player: m1[1]!, text: m1[2]!.trim() };
  }
  const m2 = CHAT_JOIN.exec(line);
  if (m2) return { kind: "join", ts: now, player: m2[1]! };
  const m3 = CHAT_LEAVE.exec(line);
  if (m3) return { kind: "leave", ts: now, player: m3[1]! };
  const m4 = CHAT_DEATH.exec(line);
  if (m4) {
    return { kind: "death", ts: now, player: m4[1]!, text: m4[2]!.trim() };
  }
  return null;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

const MAX_MSGS = 2000;
const HISTORY_FLUSH_INTERVAL_MS = 5000;

function historyKey(serverId: string): string {
  return `cofemine.chat.history.${serverId}`;
}

function loadHistory(serverId: string): ChatMsg[] {
  try {
    const raw = localStorage.getItem(historyKey(serverId));
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    // Defensive: filter anything that doesn't look like a ChatMsg.
    return arr.filter(
      (x: unknown): x is ChatMsg =>
        !!x &&
        typeof x === "object" &&
        typeof (x as { kind?: unknown }).kind === "string" &&
        typeof (x as { ts?: unknown }).ts === "number"
    );
  } catch {
    return [];
  }
}

export function ServerChat({
  serverId,
  onlinePlayers,
}: {
  serverId: string;
  onlinePlayers: string[];
}): JSX.Element {
  const { t } = useT();
  // Seed from localStorage on first render so the operator sees
  // yesterday's chat the moment they open the tab, no flicker.
  const [msgs, setMsgs] = useState<ChatMsg[]>(() =>
    typeof window === "undefined" ? [] : loadHistory(serverId)
  );
  const [draft, setDraft] = useState("");
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  // Debounced flush: localStorage.setItem on every incoming chat
  // line would be wasteful when there's a flurry; instead schedule
  // one flush per HISTORY_FLUSH_INTERVAL_MS as long as we have
  // dirty state. The ref-shadow of `msgs` is so the flush always
  // sees the latest array without re-creating the interval.
  const msgsRef = useRef<ChatMsg[]>(msgs);
  msgsRef.current = msgs;
  useEffect(() => {
    const t = setInterval(() => {
      try {
        localStorage.setItem(
          historyKey(serverId),
          JSON.stringify(msgsRef.current)
        );
      } catch {
        /* quota — give up silently, in-memory still works */
      }
    }, HISTORY_FLUSH_INTERVAL_MS);
    return () => {
      clearInterval(t);
      // Final flush on unmount so a tab switch doesn't lose the
      // last few seconds of chat.
      try {
        localStorage.setItem(
          historyKey(serverId),
          JSON.stringify(msgsRef.current)
        );
      } catch {}
    };
  }, [serverId]);

  // Same WS the console uses — single connection, browser will reuse
  // any open one if the operator is on both tabs. Reconnect logic
  // mirrors server-console.tsx.
  useEffect(() => {
    let cancelled = false;
    let reconnect: ReturnType<typeof setTimeout> | null = null;
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/api/ws/servers/${serverId}/console`;

    function open(): void {
      if (cancelled) return;
      const ws = new WebSocket(url);
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onerror = () => setConnected(false);
      ws.onclose = () => {
        setConnected(false);
        if (cancelled) return;
        reconnect = setTimeout(open, 2000);
      };
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(ev.data as string);
          if (m.type === "log" || m.type === "command-result") {
            const text: string = String(m.data ?? "");
            for (const line of text.split(/\r?\n/)) {
              if (!line.trim()) continue;
              const parsed = parseChat(line);
              if (parsed) {
                setMsgs((old) => {
                  const next = [...old, parsed];
                  return next.length > MAX_MSGS
                    ? next.slice(next.length - MAX_MSGS)
                    : next;
                });
              }
            }
          }
        } catch {
          /* not JSON — ignore (raw chunks shouldn't happen but defensive) */
        }
      };
    }
    open();
    return () => {
      cancelled = true;
      if (reconnect) clearTimeout(reconnect);
      try {
        wsRef.current?.close();
      } catch {}
    };
  }, [serverId]);

  useEffect(() => {
    if (viewRef.current) {
      viewRef.current.scrollTop = viewRef.current.scrollHeight;
    }
  }, [msgs]);

  function sendSay(): void {
    const text = draft.trim();
    if (!text || !wsRef.current) return;
    // `say <text>` shows in chat as "[Server] <text>", which is the
    // standard way an operator talks back via console.
    wsRef.current.send(
      JSON.stringify({ type: "command", command: `say ${text}` })
    );
    setDraft("");
    // Echo our own message immediately so the operator gets feedback
    // before the log streams back.
    setMsgs((old) => [
      ...old,
      { kind: "system", ts: Date.now(), text: `[Server] ${text}` },
    ]);
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_240px] gap-4">
      <div className="card overflow-hidden flex flex-col h-[600px]">
        <div className="px-4 py-2 border-b border-line flex items-center justify-between text-xs">
          <span>{t("chat.title")}</span>
          <div className="flex items-center gap-3">
            {msgs.length > 0 && (
              <button
                className="text-ink-muted hover:text-ink-secondary text-[11px]"
                onClick={() => {
                  setMsgs([]);
                  try {
                    localStorage.removeItem(historyKey(serverId));
                  } catch {}
                }}
                title={t("chat.clear")}
              >
                {t("chat.clear")} ({msgs.length})
              </button>
            )}
            <span className={connected ? "text-accent" : "text-ink-muted"}>
              {connected ? t("console.connected") : t("console.disconnected")}
            </span>
          </div>
        </div>
        <div
          ref={viewRef}
          className="flex-1 overflow-auto p-3 space-y-1.5 bg-base"
        >
          {msgs.length === 0 ? (
            <div className="text-sm text-ink-muted">{t("chat.empty")}</div>
          ) : (
            msgs.map((m, i) => <ChatRow key={i} m={m} />)
          )}
        </div>
        <div className="p-3 border-t border-line flex gap-2">
          <input
            className="input flex-1"
            placeholder={t("chat.placeholder")}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") sendSay();
            }}
            disabled={!connected}
          />
          <button
            className="btn-primary"
            onClick={sendSay}
            disabled={!connected || !draft.trim()}
          >
            {t("chat.send")}
          </button>
        </div>
      </div>

      <aside className="card p-3 h-[600px] overflow-auto">
        <h3 className="text-xs font-medium text-ink-secondary mb-2 px-1">
          {t("chat.online", { n: onlinePlayers.length })}
        </h3>
        {onlinePlayers.length === 0 ? (
          <div className="text-xs text-ink-muted px-1">
            {t("server.overview.noPlayers")}
          </div>
        ) : (
          <ul className="space-y-1">
            {onlinePlayers.map((p) => (
              <li
                key={p}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-2 text-sm"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`https://mc-heads.net/avatar/${encodeURIComponent(p)}/32`}
                  srcSet={`https://mc-heads.net/avatar/${encodeURIComponent(p)}/64 2x`}
                  alt=""
                  width={24}
                  height={24}
                  className="w-6 h-6 rounded shrink-0"
                  loading="lazy"
                />
                <span className="font-mono text-xs truncate">{p}</span>
              </li>
            ))}
          </ul>
        )}
      </aside>
    </div>
  );
}

function ChatRow({ m }: { m: ChatMsg }): JSX.Element {
  if (m.kind === "system") {
    return (
      <div className="flex items-baseline gap-2 text-xs">
        <span className="text-ink-muted shrink-0 font-mono">
          {fmtTime(m.ts)}
        </span>
        <span className="text-[rgb(var(--accent))] italic">{m.text}</span>
      </div>
    );
  }
  const tone =
    m.kind === "join"
      ? "text-emerald-400"
      : m.kind === "leave"
        ? "text-amber-400"
        : m.kind === "death"
          ? "text-rose-400"
          : "text-ink";
  return (
    <div className="flex items-start gap-2 text-sm leading-snug">
      <span className="text-[10px] text-ink-muted shrink-0 font-mono pt-1 w-12">
        {fmtTime(m.ts)}
      </span>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`https://mc-heads.net/avatar/${encodeURIComponent(m.player)}/24`}
        srcSet={`https://mc-heads.net/avatar/${encodeURIComponent(m.player)}/48 2x`}
        alt=""
        width={20}
        height={20}
        className="w-5 h-5 rounded shrink-0 mt-0.5"
        loading="lazy"
      />
      <div className="flex-1 min-w-0">
        <span className="font-medium font-mono text-xs mr-2">
          {m.player}
        </span>
        {m.kind === "say" ? (
          <span className="break-words">{m.text}</span>
        ) : (
          <span className={`${tone} italic break-words`}>
            {m.kind === "join"
              ? "joined the game"
              : m.kind === "leave"
                ? "left the game"
                : m.text}
          </span>
        )}
      </div>
    </div>
  );
}
