"use client";
import useSWR from "swr";
import { fetcher } from "@/lib/api";

type Me = { id: string; email: string; username: string; role: string };

export default function SettingsPage(): JSX.Element {
  const { data } = useSWR<Me>("/auth/me", fetcher);
  return (
    <div className="space-y-6 max-w-xl">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <div className="card p-5 space-y-3">
        <h2 className="font-medium">Account</h2>
        <div className="text-sm space-y-1">
          <div>
            <span className="text-zinc-500">Username:</span> {data?.username}
          </div>
          <div>
            <span className="text-zinc-500">Email:</span> {data?.email}
          </div>
          <div>
            <span className="text-zinc-500">Role:</span> {data?.role}
          </div>
        </div>
      </div>
      <div className="card p-5 space-y-3">
        <h2 className="font-medium">Panel</h2>
        <p className="text-sm text-zinc-400">
          Cofemine Panel v0.1.0 — self-hosted Docker-first Minecraft control
          panel. See <code>docs/</code> for architecture, deployment, and API
          reference.
        </p>
      </div>
    </div>
  );
}
