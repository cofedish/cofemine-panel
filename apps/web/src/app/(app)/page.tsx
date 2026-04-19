"use client";
import useSWR from "swr";
import Link from "next/link";
import { fetcher } from "@/lib/api";
import { ServerCard, type ServerSummary } from "@/components/server-card";
import { Server, HardDrive, Users } from "lucide-react";

export default function Dashboard(): JSX.Element {
  const { data: servers } = useSWR<ServerSummary[]>("/servers", fetcher);
  const { data: nodes } = useSWR<Array<{ id: string; status: string }>>(
    "/nodes",
    fetcher
  );
  const { data: users } = useSWR<Array<unknown>>("/users", fetcher);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="text-sm text-zinc-400 mt-1">
          Overview of your infrastructure.
        </p>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Stat icon={<Server size={18} />} label="Servers" value={servers?.length ?? 0} />
        <Stat icon={<HardDrive size={18} />} label="Nodes online" value={
          nodes?.filter((n) => n.status === "ONLINE").length ?? 0
        } suffix={`/ ${nodes?.length ?? 0}`} />
        <Stat icon={<Users size={18} />} label="Users" value={users?.length ?? "—"} />
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-medium">Your servers</h2>
          <Link href="/servers/new" className="btn-primary">
            Create server
          </Link>
        </div>
        {servers && servers.length > 0 ? (
          <div className="grid grid-cols-2 gap-4">
            {servers.map((s) => (
              <ServerCard key={s.id} server={s} />
            ))}
          </div>
        ) : (
          <div className="card p-10 text-center text-zinc-500">
            No servers yet. Click <b>Create server</b> to spin one up.
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  suffix,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  suffix?: string;
}): JSX.Element {
  return (
    <div className="card p-5 flex items-center gap-4">
      <div className="w-10 h-10 rounded-md bg-surface-2 grid place-items-center text-accent">
        {icon}
      </div>
      <div>
        <div className="text-xs text-zinc-400 uppercase tracking-wide">
          {label}
        </div>
        <div className="text-2xl font-semibold mt-0.5">
          {value}
          {suffix && <span className="text-sm text-zinc-500 ml-1">{suffix}</span>}
        </div>
      </div>
    </div>
  );
}
