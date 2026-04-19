"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api";

export default function SetupPage(): JSX.Element {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [username, setU] = useState("");
  const [password, setP] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.post("/auth/setup", { email, username, password });
      router.push("/");
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Setup failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen grid place-items-center bg-surface-0">
      <form onSubmit={submit} className="card p-8 w-[420px] space-y-4">
        <div>
          <div className="text-xl font-semibold">First-run setup</div>
          <div className="text-sm text-zinc-400 mt-1">
            Create the initial <b>owner</b> account. You can add more users later.
          </div>
        </div>
        <div className="space-y-2">
          <label className="text-xs text-zinc-400">Email</label>
          <input
            type="email"
            className="input"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <label className="text-xs text-zinc-400">Username</label>
          <input
            className="input"
            required
            value={username}
            onChange={(e) => setU(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <label className="text-xs text-zinc-400">Password (min 8 chars)</label>
          <input
            type="password"
            className="input"
            required
            value={password}
            onChange={(e) => setP(e.target.value)}
          />
        </div>
        {err && <div className="text-danger text-sm">{err}</div>}
        <button disabled={busy} className="btn-primary w-full justify-center">
          {busy ? "Creating…" : "Create owner account"}
        </button>
      </form>
    </div>
  );
}
