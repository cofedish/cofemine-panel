"use client";
import { useEffect, useRef, useState } from "react";

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
  const [lines, setLines] = useState<string[]>([]);
  const [cmd, setCmd] = useState("");
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelled = useRef(false);

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
    if (!cmd.trim() || !wsRef.current) return;
    wsRef.current.send(JSON.stringify({ type: "command", command: cmd }));
    setLines((old) => truncate([...old, `$ ${cmd}`]));
    setCmd("");
  }

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-line text-xs">
        <span>Console</span>
        <span className={connected ? "text-accent" : "text-ink-muted"}>
          {connected ? "connected" : "disconnected"}
        </span>
      </div>
      <div
        ref={viewRef}
        className="font-mono text-xs whitespace-pre-wrap bg-base p-4 h-[480px] overflow-auto"
      >
        {lines.length === 0 ? (
          <div className="text-ink-muted">Waiting for output…</div>
        ) : (
          lines.join("")
        )}
      </div>
      <div className="p-3 border-t border-line flex gap-2">
        <input
          className="input font-mono text-xs"
          placeholder="say Hello, world"
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") send();
          }}
        />
        <button className="btn-primary" onClick={send} disabled={!connected}>
          Send
        </button>
      </div>
    </div>
  );
}

function truncate(arr: string[]): string[] {
  const MAX = 2000;
  return arr.length > MAX ? arr.slice(arr.length - MAX) : arr;
}
