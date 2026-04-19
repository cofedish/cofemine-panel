"use client";
import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api";

type Status = "loading" | "ok" | "unauth" | "setup";

export function AuthGate({ children }: { children: ReactNode }): JSX.Element {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("loading");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const s = await api.get<{ setupRequired: boolean }>(
          "/auth/setup-status"
        );
        if (!alive) return;
        if (s.setupRequired) {
          setStatus("setup");
          router.replace("/setup");
          return;
        }
        await api.get("/auth/me");
        if (!alive) return;
        setStatus("ok");
      } catch (err) {
        if (!alive) return;
        if (err instanceof ApiError && err.status === 401) {
          setStatus("unauth");
          router.replace("/login");
        } else {
          setStatus("unauth");
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [router]);

  if (status !== "ok") {
    return (
      <div className="min-h-screen flex items-center justify-center text-zinc-500 text-sm">
        Loading…
      </div>
    );
  }
  return <>{children}</>;
}
