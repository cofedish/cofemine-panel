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

type ChatMsg = (
  | { kind: "say"; player: string; text: string }
  | { kind: "join"; player: string }
  | { kind: "leave"; player: string }
  | { kind: "death"; player: string; text: string }
  | { kind: "system"; text: string }
) & {
  /** Wall-clock ms when WE saw the line — used for display. */
  ts: number;
  /** HH:MM:SS string parsed from the log line itself. The same chat
   *  event replayed by the WS on reconnect has the same logTime, so
   *  this is what we hash for dedup. Optional because some sources
   *  (operator-typed `say`) don't have a log timestamp yet. */
  logTime?: string;
};

// ANSI/colour escapes (itzg's runner pipes minecraft's coloured
// stdout through with the escapes intact). Strip before regex
// matching so [33m doesn't break the <Name> capture.
const ANSI_RE = /\x1b\[[0-9;]*m/g;
// Leading [HH:MM:SS] (with optional milliseconds) — used both for
// dedup keying and to recover the original send-time after a
// localStorage reload.
const TIMESTAMP_RE = /^\[(\d{2}:\d{2}:\d{2}(?:\.\d+)?)\]/;

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
  const tsMatch = TIMESTAMP_RE.exec(line);
  const logTime = tsMatch?.[1];
  const now = Date.now();
  const m1 = CHAT_SAY.exec(line);
  if (m1) {
    return {
      kind: "say",
      ts: now,
      logTime,
      player: m1[1]!,
      text: m1[2]!.trim(),
    };
  }
  const m2 = CHAT_JOIN.exec(line);
  if (m2) return { kind: "join", ts: now, logTime, player: m2[1]! };
  const m3 = CHAT_LEAVE.exec(line);
  if (m3) return { kind: "leave", ts: now, logTime, player: m3[1]! };
  const m4 = CHAT_DEATH.exec(line);
  if (m4) {
    return {
      kind: "death",
      ts: now,
      logTime,
      player: m4[1]!,
      text: m4[2]!.trim(),
    };
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
const HISTORY_FLUSH_DEBOUNCE_MS = 750;
/** How many recent messages to scan for content-equality when
 *  deduping incoming lines. The WS replays the last ~100 lines of
 *  docker logs on every connect/reconnect (which fires on full page
 *  reload too); without dedup, those re-arrive on top of what we
 *  already loaded from localStorage. Scanning 200 covers a typical
 *  replay window. */
const DEDUP_WINDOW = 200;

/**
 * Stable hash key for dedup. Keyed on the log-line timestamp instead
 * of wall-clock ts — the same chat event replayed by the WS on
 * reconnect produces the same logTime, so the match works across
 * mounts. Player who genuinely flooded the same word in different
 * seconds gets different keys → not deduped. Replayed history with
 * identical logTime → deduped.
 *
 * Optimistic `system` lines from operator-typed `say` don't have a
 * logTime, so they include wall-clock ts in the key — that prevents
 * two clicks on Say from collapsing into one, while still allowing
 * dedup against future replays of themselves (they were never in
 * the log to begin with, so replay isn't a concern).
 */
function msgKey(m: ChatMsg): string {
  const t = m.logTime ?? `wall:${m.ts}`;
  switch (m.kind) {
    case "say":
      return `say:${t}:${m.player}:${m.text}`;
    case "join":
      return `join:${t}:${m.player}`;
    case "leave":
      return `leave:${t}:${m.player}`;
    case "death":
      return `death:${t}:${m.player}:${m.text}`;
    case "system":
      return `sys:${t}:${m.text}`;
  }
}

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
  // Debounced flush: every state change schedules one save 750ms
  // later, with the timer reset on each new change. Captures all the
  // chat events from a single second-long flurry into one localStorage
  // write, but still saves fast enough that a refresh moments after
  // an op types `say something` doesn't lose it (the previous 5s
  // interval did). Unmount flushes synchronously regardless.
  const msgsRef = useRef<ChatMsg[]>(msgs);
  msgsRef.current = msgs;
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(
          historyKey(serverId),
          JSON.stringify(msgsRef.current)
        );
      } catch {
        /* quota — give up silently, in-memory still works */
      }
    }, HISTORY_FLUSH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [msgs, serverId]);
  useEffect(() => {
    return () => {
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
              if (!parsed) continue;
              setMsgs((old) => {
                // Dedup against the last DEDUP_WINDOW entries. On
                // page reload the WS replays the recent log buffer
                // — without this every refresh would tile the same
                // chat lines on top of what we restored from
                // localStorage. Optimistic `say` we appended below
                // also collides with the server's own echo of the
                // command, which we want — keeps the local entry,
                // drops the duplicate.
                const k = msgKey(parsed);
                const tail = old.slice(Math.max(0, old.length - DEDUP_WINDOW));
                if (tail.some((x) => msgKey(x) === k)) return old;
                const next = [...old, parsed];
                return next.length > MAX_MSGS
                  ? next.slice(next.length - MAX_MSGS)
                  : next;
              });
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
    // before the log streams back. Flush synchronously after — the
    // debounce timer might not fire if the operator refreshes 200ms
    // later, and losing the line they just sent would be confusing.
    setMsgs((old) => {
      const next = [
        ...old,
        {
          kind: "system" as const,
          ts: Date.now(),
          text: `[Server] ${text}`,
        },
      ];
      try {
        localStorage.setItem(historyKey(serverId), JSON.stringify(next));
      } catch {}
      return next;
    });
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
