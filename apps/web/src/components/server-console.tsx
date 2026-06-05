"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/lib/i18n";

/**
 * Vanilla MC commands + common plugin/loader ones. Sorted by how
 * often operators actually use them (the suggest popup shows the
 * top match prominently, so order matters). Plugin-specific names
 * (bluemap, ftbquests) are deliberately included because that's the
 * stack this panel targets — adding everything in /help would just
 * fill the popup with noise.
 *
 * Not exhaustive on purpose. Operators can still type any command;
 * autocomplete only fires when the prefix matches one of these.
 */
const KNOWN_COMMANDS = [
  // most common server-ops
  "say", "tell", "msg", "tp", "teleport", "give", "kill",
  "kick", "ban", "ban-ip", "pardon", "pardon-ip", "op", "deop",
  "whitelist", "save-all", "save-on", "save-off", "stop",
  "gamemode", "gamerule", "difficulty", "time", "weather", "seed",
  "list", "advancement", "attribute", "effect", "enchant",
  "experience", "xp", "fill", "setblock", "summon", "clear",
  "clone", "data", "datapack", "execute", "function", "particle",
  "playsound", "stopsound", "recipe", "reload", "schedule",
  "scoreboard", "spawnpoint", "spreadplayers", "tag", "team",
  "title", "tellraw", "trigger", "worldborder",
  "forceload", "locate", "loot", "ride", "spectate",
  // loader / mod ecosystem
  "forge", "neoforge", "fabric",
  "ftbquests", "ftbteams", "ftbchunks", "ftbessentials",
  "bluemap", "dynmap", "voicechat",
  // perms-ish (most server packs ship one of these)
  "luckperms", "lp",
] as const;

/** localStorage key for command history (kept per-server). */
function historyKey(serverId: string): string {
  return `cofemine.console.history.${serverId}`;
}
const HISTORY_MAX = 100;

/**
 * Live console. Opens a WebSocket to the panel-api, which proxies to the
 * agent. Supports both log streaming and sending commands.
 *
 * On restart: the agent's log stream ends when the container stops, so
 * the socket closes. We auto-reconnect after a short delay AND clear the
 * old buffer — otherwise yesterday's crash would still be sitting on
 * screen above a freshly booted "Starting server…" which is confusing.
 */
export function ServerConsole({ serverId }: { serverId: string }): JSX.Element {
  const { t } = useT();
  const [lines, setLines] = useState<string[]>([]);
  const [cmd, setCmd] = useState("");
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelled = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // History — persisted per server in localStorage. Initialized once
  // on mount; the in-memory copy is the source of truth thereafter
  // and is flushed back on every send().
  const [history, setHistory] = useState<string[]>([]);
  // -1 means "live input"; 0..history.length-1 means "showing entry N
  // from the end" (Up = older, Down = newer, like bash).
  const [histPos, setHistPos] = useState(-1);
  // Suggestion popup state.
  const [suggestIdx, setSuggestIdx] = useState(0);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(historyKey(serverId));
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          setHistory(parsed.filter((s) => typeof s === "string"));
        }
      }
    } catch {
      /* localStorage unavailable / corrupted — start empty */
    }
  }, [serverId]);

  // Suggestions: filter KNOWN_COMMANDS by the typed prefix, but only
  // when the user is typing the FIRST token. Subsequent args don't
  // get suggestions yet — that'd need per-command arg specs.
  const suggestions = useMemo<string[]>(() => {
    const trimmed = cmd.trimStart();
    if (!trimmed) return [];
    if (trimmed.includes(" ")) return [];
    const head = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
    if (!head) return [];
    const lower = head.toLowerCase();
    // Exact match → nothing to suggest. Prefix match → top 6.
    const hits = KNOWN_COMMANDS.filter((c) => c.startsWith(lower));
    if (hits.length === 1 && hits[0] === lower) return [];
    return hits.slice(0, 6);
  }, [cmd]);

  // Keep the suggest highlight in range when the list shrinks.
  useEffect(() => {
    if (suggestIdx >= suggestions.length) setSuggestIdx(0);
  }, [suggestions.length, suggestIdx]);

  useEffect(() => {
    cancelled.current = false;
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/api/ws/servers/${serverId}/console`;

    function open(): void {
      if (cancelled.current) return;
      // Wipe stale buffer so the user doesn't see last session's output
      // mixed in with the new one after a restart.
      setLines([]);
      const ws = new WebSocket(url);
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onerror = () => setConnected(false);
      ws.onclose = () => {
        setConnected(false);
        if (cancelled.current) return;
        // The agent closes the socket when the log stream ends (stop /
        // restart / container recreate). Give Docker a moment to bring
        // the new container up, then reconnect on a fresh buffer.
        reconnectTimer.current = setTimeout(open, 2000);
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string);
          if (msg.type === "log") {
            setLines((old) => truncate([...old, msg.data]));
          } else if (msg.type === "command-result") {
            setLines((old) => truncate([...old, `> ${msg.data}`]));
          } else if (msg.type === "status" || msg.type === "error") {
            setLines((old) =>
              truncate([...old, `[${msg.type}] ${msg.message}\n`])
            );
          }
        } catch {
          setLines((old) => truncate([...old, String(ev.data)]));
        }
      };
    }

    open();
    return () => {
      cancelled.current = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      try {
        wsRef.current?.close();
      } catch {}
    };
  }, [serverId]);

  useEffect(() => {
    if (viewRef.current) {
      viewRef.current.scrollTop = viewRef.current.scrollHeight;
    }
  }, [lines]);

  function send(): void {
    const trimmed = cmd.trim();
    if (!trimmed || !wsRef.current) return;
    wsRef.current.send(JSON.stringify({ type: "command", command: cmd }));
    setLines((old) => truncate([...old, `$ ${cmd}`]));
    // Append to history (no consecutive duplicates), persist.
    setHistory((prev) => {
      const next =
        prev[prev.length - 1] === trimmed ? prev : [...prev, trimmed];
      const capped = next.slice(-HISTORY_MAX);
      try {
        localStorage.setItem(historyKey(serverId), JSON.stringify(capped));
      } catch {
        /* quota — silently drop persistence, in-memory still works */
      }
      return capped;
    });
    setHistPos(-1);
    setCmd("");
  }

  /**
   * Replace the first token (the command) with `name`, preserving any
   * args the operator already typed (rare, since suggestions only show
   * with no space yet — but defensive). Slash prefix is kept if the
   * operator typed one.
   */
  function applyCompletion(name: string): void {
    const leading = cmd.startsWith("/") ? "/" : "";
    setCmd(`${leading}${name} `);
    setSuggestIdx(0);
    inputRef.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    // Tab — apply currently highlighted suggestion. If none, just
    // swallow the Tab so focus doesn't jump out of the input.
    if (e.key === "Tab") {
      e.preventDefault();
      if (suggestions.length > 0) {
        applyCompletion(suggestions[suggestIdx] ?? suggestions[0]!);
      }
      return;
    }
    // ArrowUp / ArrowDown — move through history (bash-style) when
    // there are no live suggestions to navigate; otherwise move the
    // suggestion highlight. The mental model: typing 'gam' offers
    // gamemode/gamerule — up/down picks between them. Empty input
    // → up/down walks history.
    if (e.key === "ArrowUp") {
      if (suggestions.length > 0) {
        e.preventDefault();
        setSuggestIdx((i) => (i - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (history.length === 0) return;
      e.preventDefault();
      const next = Math.min(histPos + 1, history.length - 1);
      setHistPos(next);
      setCmd(history[history.length - 1 - next] ?? "");
      return;
    }
    if (e.key === "ArrowDown") {
      if (suggestions.length > 0) {
        e.preventDefault();
        setSuggestIdx((i) => (i + 1) % suggestions.length);
        return;
      }
      if (histPos < 0) return;
      e.preventDefault();
      const next = histPos - 1;
      setHistPos(next);
      setCmd(next < 0 ? "" : (history[history.length - 1 - next] ?? ""));
      return;
    }
    if (e.key === "Enter") {
      // If a suggestion is highlighted AND the user hasn't typed a
      // space yet, Enter completes the suggestion instead of sending —
      // matches what every shell does.
      if (suggestions.length > 0 && !cmd.trim().includes(" ")) {
        e.preventDefault();
        applyCompletion(suggestions[suggestIdx] ?? suggestions[0]!);
        return;
      }
      send();
      return;
    }
    if (e.key === "Escape") {
      // Dismiss suggestions / cancel history navigation.
      if (histPos >= 0) {
        setHistPos(-1);
        setCmd("");
      }
      setSuggestIdx(0);
    }
  }

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-line text-xs">
        <span>{t("console.title")}</span>
        <span className={connected ? "text-accent" : "text-ink-muted"}>
          {connected ? t("console.connected") : t("console.disconnected")}
        </span>
      </div>
      <div
        ref={viewRef}
        className="font-mono text-xs whitespace-pre-wrap bg-base p-4 h-[480px] overflow-auto"
      >
        {lines.length === 0 ? (
          <div className="text-ink-muted">{t("console.waiting")}</div>
        ) : (
          lines.join("")
        )}
      </div>
      <div className="p-3 border-t border-line">
        <div className="relative flex gap-2">
          {/* Suggestion popup floats above the input. Click also
              completes — handy when the operator is hunting and
              doesn't know what the command name is. */}
          {suggestions.length > 0 && (
            <ul className="absolute bottom-full left-0 mb-1 z-10 w-72 max-h-60 overflow-auto rounded-md border border-border/60 bg-surface-1 shadow-lg text-xs font-mono">
              {suggestions.map((s, i) => (
                <li key={s}>
                  <button
                    type="button"
                    className={
                      "w-full text-left px-3 py-1.5 hover:bg-surface-2 " +
                      (i === suggestIdx
                        ? "bg-[rgb(var(--accent-soft))] text-[rgb(var(--accent))]"
                        : "")
                    }
                    onMouseDown={(e) => {
                      // mousedown (not click) so the input doesn't
                      // lose focus before applyCompletion runs.
                      e.preventDefault();
                      applyCompletion(s);
                    }}
                  >
                    /{s}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <input
            ref={inputRef}
            className="input font-mono text-xs flex-1"
            placeholder={t("console.placeholder")}
            value={cmd}
            onChange={(e) => {
              setCmd(e.target.value);
              setHistPos(-1);
            }}
            onKeyDown={onKeyDown}
            autoComplete="off"
            spellCheck={false}
          />
          <button className="btn-primary" onClick={send} disabled={!connected}>
            {t("console.send")}
          </button>
        </div>
        {suggestions.length === 0 && history.length > 0 && histPos === -1 && (
          <div className="text-[10px] text-ink-muted mt-1.5 select-none">
            {t("console.hint")}
          </div>
        )}
      </div>
    </div>
  );
}

function truncate(arr: string[]): string[] {
  const MAX = 2000;
  return arr.length > MAX ? arr.slice(arr.length - MAX) : arr;
}
