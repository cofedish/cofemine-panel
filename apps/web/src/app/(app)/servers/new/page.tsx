"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { api, ApiError, fetcher } from "@/lib/api";
import { SERVER_TYPES } from "@cofemine/shared";

type Node = { id: string; name: string; status: string };
type Template = {
  id: string;
  name: string;
  type: string;
  version: string;
  memoryMb: number;
  env: Record<string, string>;
};

export default function CreateServerPage(): JSX.Element {
  const router = useRouter();
  const { data: nodes } = useSWR<Node[]>("/nodes", fetcher);
  const { data: templates } = useSWR<Template[]>("/templates", fetcher);

  const [templateId, setTemplateId] = useState<string>("");
  const [name, setName] = useState("survival");
  const [description, setDescription] = useState("");
  const [nodeId, setNodeId] = useState<string>("");
  const [type, setType] = useState<(typeof SERVER_TYPES)[number]>("PAPER");
  const [version, setVersion] = useState("1.21.1");
  const [memoryMb, setMemoryMb] = useState(2048);
  const [hostPort, setHostPort] = useState(25565);
  const [envText, setEnvText] = useState("DIFFICULTY=normal\nMAX_PLAYERS=20");
  const [eula, setEula] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function applyTemplate(id: string): void {
    setTemplateId(id);
    const t = templates?.find((t) => t.id === id);
    if (!t) return;
    setType(t.type as any);
    setVersion(t.version);
    setMemoryMb(t.memoryMb);
    setEnvText(
      Object.entries(t.env ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join("\n")
    );
  }

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const env: Record<string, string> = {};
      for (const line of envText.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq < 1) continue;
        env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
      }
      const res = await api.post<{ id: string }>("/servers", {
        name,
        description: description || undefined,
        nodeId,
        type,
        version,
        memoryMb: Number(memoryMb),
        ports: [{ host: Number(hostPort), container: 25565, protocol: "tcp" }],
        env,
        eulaAccepted: eula,
        templateId: templateId || undefined,
      });
      router.push(`/servers/${res.id}`);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Create server</h1>
        <p className="text-sm text-ink-secondary mt-1">
          Minecraft servers run as sibling Docker containers using{" "}
          <code className="text-ink">itzg/minecraft-server</code>.
        </p>
      </div>

      <section className="card p-5 space-y-4">
        <h2 className="font-medium">Template</h2>
        <select
          className="select"
          value={templateId}
          onChange={(e) => applyTemplate(e.target.value)}
        >
          <option value="">— no template —</option>
          {templates?.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} · {t.type} · {t.version}
            </option>
          ))}
        </select>
      </section>

      <section className="card p-5 space-y-4">
        <h2 className="font-medium">Basics</h2>
        <div className="grid grid-cols-2 gap-4">
          <Labeled label="Name">
            <input
              className="input"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Labeled>
          <Labeled label="Node">
            <select
              className="select"
              required
              value={nodeId}
              onChange={(e) => setNodeId(e.target.value)}
            >
              <option value="">— select node —</option>
              {nodes?.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name} ({n.status})
                </option>
              ))}
            </select>
          </Labeled>
        </div>
        <Labeled label="Description (optional)">
          <input
            className="input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Labeled>
      </section>

      <section className="card p-5 space-y-4">
        <h2 className="font-medium">Runtime</h2>
        <div className="grid grid-cols-3 gap-4">
          <Labeled label="Type">
            <select
              className="select"
              value={type}
              onChange={(e) => setType(e.target.value as any)}
            >
              {SERVER_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </Labeled>
          <Labeled label="Version">
            <input
              className="input"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              placeholder="1.21.1 or LATEST"
            />
          </Labeled>
          <Labeled label="Memory (MB)">
            <input
              className="input"
              type="number"
              min={512}
              max={65536}
              step={512}
              value={memoryMb}
              onChange={(e) => setMemoryMb(Number(e.target.value))}
            />
          </Labeled>
        </div>
        <Labeled label="Host port (container: 25565)">
          <input
            className="input"
            type="number"
            min={1}
            max={65535}
            value={hostPort}
            onChange={(e) => setHostPort(Number(e.target.value))}
          />
        </Labeled>
        <Labeled label="Environment (KEY=VALUE per line)">
          <textarea
            className="textarea font-mono text-xs h-32"
            value={envText}
            onChange={(e) => setEnvText(e.target.value)}
          />
        </Labeled>
      </section>

      <section className="card p-5">
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={eula}
            onChange={(e) => setEula(e.target.checked)}
            className="mt-1"
          />
          <span>
            I accept the{" "}
            <a
              className="text-accent underline"
              href="https://www.minecraft.net/en-us/eula"
              target="_blank"
              rel="noreferrer"
            >
              Minecraft EULA
            </a>
            . Required to run any Minecraft server.
          </span>
        </label>
      </section>

      {err && <div className="text-danger text-sm">{err}</div>}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          className="btn-ghost"
          onClick={() => router.back()}
        >
          Cancel
        </button>
        <button disabled={busy || !eula} className="btn-primary">
          {busy ? "Creating…" : "Create server"}
        </button>
      </div>
    </form>
  );
}

function Labeled({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="space-y-1">
      <div className="text-xs text-ink-secondary">{label}</div>
      {children}
    </div>
  );
}
