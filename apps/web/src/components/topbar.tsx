"use client";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { api, fetcher } from "@/lib/api";
import { LogOut } from "lucide-react";
import { ThemeToggle } from "./appearance-switcher";

type Me = { id: string; email: string; username: string; role: string };

export function Topbar(): JSX.Element {
  const router = useRouter();
  const { data } = useSWR<Me>("/auth/me", fetcher);

  async function logout(): Promise<void> {
    await api.post("/auth/logout").catch(() => {});
    router.push("/login");
  }

  return (
    <header className="h-14 border-b border-line px-6 flex items-center justify-between bg-surface-1/60 backdrop-blur-xl sticky top-0 z-30">
      <div className="text-sm text-ink-muted">
        {greeting()}
        {data?.username ? (
          <>
            , <span className="text-ink font-medium">{data.username}</span>
          </>
        ) : null}
      </div>
      <div className="flex items-center gap-2 text-sm">
        {data && (
          <span className="badge badge-accent mr-1">{data.role}</span>
        )}
        <ThemeToggle />
        <button
          onClick={logout}
          className="btn-ghost !py-1.5 !px-2.5"
          aria-label="Sign out"
        >
          <LogOut size={14} />
          <span className="hidden sm:inline">Sign out</span>
        </button>
      </div>
    </header>
  );
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 6) return "Late brew";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}
