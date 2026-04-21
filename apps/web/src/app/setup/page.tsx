"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { AuthShell } from "@/components/auth-shell";
import { LogoMark, Wordmark } from "@/components/logo";

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
    <AuthShell
      title="Welcome."
      subtitle="Let's create the first account. This person becomes the OWNER and can invite others later."
      quote="Roles are enforced at the API layer, audited in the panel, and default to least-privilege."
      cite="Security model"
    >
      <form onSubmit={submit} className="space-y-5">
        <div className="lg:hidden flex items-center gap-2.5 mb-2">
          <span className="w-9 h-9 rounded-lg bg-[rgb(var(--accent-soft))] text-[rgb(var(--accent))] grid place-items-center">
            <LogoMark size={22} />
          </span>
          <Wordmark className="text-lg" />
        </div>

        <div>
          <h1 className="heading-xl">First-run setup</h1>
          <p className="text-sm text-ink-secondary mt-1.5">
            Create the OWNER account. Runs once.
          </p>
        </div>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-ink-secondary">
              Email
            </label>
            <input
              type="email"
              className="input"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-ink-secondary">
              Username
            </label>
            <input
              className="input"
              required
              value={username}
              onChange={(e) => setU(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-ink-secondary">
              Password
            </label>
            <input
              type="password"
              className="input"
              required
              minLength={8}
              value={password}
              onChange={(e) => setP(e.target.value)}
            />
            <div className="text-xs text-ink-muted">min 8 characters</div>
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
          {busy ? "Creating…" : "Create owner account"}
        </button>
      </form>
    </AuthShell>
  );
}
