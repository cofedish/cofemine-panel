"use client";
import { useState, useEffect, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { AuthShell } from "@/components/auth-shell";
import { LogoMark, Wordmark } from "@/components/logo";

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
    <AuthShell
      title="Minecraft servers, without the yak-shaving."
      subtitle="Create, scale, and operate containers for Paper, Vanilla, Fabric, Forge and friends — with live consoles, backups, and mod installers built in."
      quote="Spin up Paper 1.21 in under a minute; the panel handles EULA, RCON and volumes for you."
      cite="Cofemine docs"
    >
      <form onSubmit={submit} className="space-y-5">
        <div className="lg:hidden flex items-center gap-2.5 mb-2">
          <span className="w-9 h-9 rounded-lg bg-[rgb(var(--accent-soft))] text-[rgb(var(--accent))] grid place-items-center">
            <LogoMark size={22} />
          </span>
          <Wordmark className="text-lg" />
        </div>

        <div>
          <h1 className="heading-xl">Sign in</h1>
          <p className="text-sm text-ink-secondary mt-1.5">
            Welcome back. Enter your credentials to continue.
          </p>
        </div>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-ink-secondary">
              Username or email
            </label>
            <input
              className="input"
              autoFocus
              value={usernameOrEmail}
              onChange={(e) => setU(e.target.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-ink-secondary">
              Password
            </label>
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setP(e.target.value)}
              required
            />
          </div>
        </div>

        {err && (
          <div className="chip chip-danger !h-auto !py-2 !px-3">{err}</div>
        )}

        <button
          disabled={busy}
          className="btn btn-primary w-full"
          type="submit"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </AuthShell>
  );
}
