"use client";
import { useState, useEffect, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api";

export default function LoginPage(): JSX.Element {
  const router = useRouter();
  const [usernameOrEmail, setU] = useState("");
  const [password, setP] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<{ setupRequired: boolean }>("/auth/setup-status")
      .then((s) => {
        if (s.setupRequired) router.replace("/setup");
      })
      .catch(() => {});
  }, [router]);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.post("/auth/login", { usernameOrEmail, password });
      router.push("/");
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen grid place-items-center bg-surface-0">
      <form
        onSubmit={submit}
        className="card p-8 w-[360px] space-y-4 shadow-xl"
      >
        <div>
          <div className="text-xl font-semibold">
            <span className="text-accent">cofemine</span> panel
          </div>
          <div className="text-sm text-zinc-400 mt-1">Sign in to continue</div>
        </div>
        <div className="space-y-2">
          <label className="text-xs text-zinc-400">Username or email</label>
          <input
            className="input"
            autoFocus
            value={usernameOrEmail}
            onChange={(e) => setU(e.target.value)}
            required
          />
        </div>
        <div className="space-y-2">
          <label className="text-xs text-zinc-400">Password</label>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setP(e.target.value)}
            required
          />
        </div>
        {err && <div className="text-danger text-sm">{err}</div>}
        <button disabled={busy} className="btn-primary w-full justify-center">
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
