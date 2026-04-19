"use client";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { api, fetcher } from "@/lib/api";
import { LogOut } from "lucide-react";

type Me = { id: string; email: string; username: string; role: string };

export function Topbar(): JSX.Element {
  const router = useRouter();
  const { data } = useSWR<Me>("/auth/me", fetcher);

  async function logout(): Promise<void> {
    await api.post("/auth/logout").catch(() => {});
    router.push("/login");
  }

  return (
    <header className="h-14 border-b border-surface-border px-6 flex items-center justify-between bg-surface-1/80 backdrop-blur">
      <div className="text-sm text-zinc-400">Welcome back</div>
      <div className="flex items-center gap-4 text-sm">
        {data && (
          <div className="flex items-center gap-2">
            <div className="text-zinc-200">{data.username}</div>
            <span className="badge bg-accent-muted text-accent">
              {data.role}
            </span>
          </div>
        )}
        <button onClick={logout} className="btn-ghost !py-1.5 !px-2">
          <LogOut size={14} /> Logout
        </button>
      </div>
    </header>
  );
}
