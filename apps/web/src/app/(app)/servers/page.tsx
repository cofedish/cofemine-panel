"use client";
import useSWR from "swr";
import Link from "next/link";
import { fetcher } from "@/lib/api";
import { ServerCard, type ServerSummary } from "@/components/server-card";

export default function ServersPage(): JSX.Element {
  const { data: servers, isLoading } = useSWR<ServerSummary[]>(
    "/servers",
    fetcher
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Servers</h1>
        <Link href="/servers/new" className="btn-primary">
          Create server
        </Link>
      </div>
      {isLoading ? (
        <div className="card p-10 text-center text-zinc-500">Loading…</div>
      ) : servers && servers.length > 0 ? (
        <div className="grid grid-cols-2 gap-4">
          {servers.map((s) => (
            <ServerCard key={s.id} server={s} />
          ))}
        </div>
      ) : (
        <div className="card p-10 text-center text-zinc-500">
          No servers yet. Create your first one.
        </div>
      )}
    </div>
  );
}
