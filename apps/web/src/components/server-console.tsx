"use client";
import { useEffect, useRef, useState } from "react";

/**
 * Live console. Opens a WebSocket to the panel-api, which proxies to the
 * agent. Supports both log streaming and sending commands.
 */
export function ServerConsole({ serverId }: { serverId: string }): JSX.Element {
  const [lines, setLines] = useState<string[]>([]);
  const [cmd, setCmd] = useState("");
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const viewRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/api/ws/servers/${serverId}/console`;
    const ws = new WebSocket(url);
    wsRef.current = ws;
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string);
        if (msg.type === "log") {
          setLines((old) => truncate([...old, msg.data]));
        } else if (msg.type === "command-result") {
          setLines((old) => truncate([...old, `> ${msg.data}`]));
        } else if (msg.type === "status" || msg.type === "error") {
          setLines((old) => truncate([...old, `[${msg.type}] ${msg.message}`]));
        }
      } catch {
        setLines((old) => truncate([...old, String(ev.data)]));
      }
    };
    return () => {
      try {
        ws.close();
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
