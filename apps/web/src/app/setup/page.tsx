"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { api, ApiError } from "@/lib/api";
import { LogoMark, Wordmark } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";

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
    <div className="min-h-screen grid place-items-center px-4 relative">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <motion.form
        onSubmit={submit}
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: [0.2, 0.8, 0.2, 1] }}
        className="card p-8 w-full max-w-[460px] space-y-5 shadow-lift"
      >
        <div className="flex items-center gap-3">
          <span className="w-10 h-10 rounded-lg bg-accent-soft text-ink grid place-items-center block-accent animate-subtle-bob">
            <LogoMark size={24} />
          </span>
          <div>
            <Wordmark className="text-xl" />
            <div className="text-xs text-ink-muted mt-0.5">First-run setup</div>
          </div>
        </div>
        <p className="text-sm text-ink-secondary leading-relaxed">
          Create the initial <b className="text-ink">owner</b> account. You can invite
          more users later from the <b>Users</b> page.
        </p>

        <div className="divider" />

        <div className="space-y-2">
          <label className="text-xs text-ink-muted font-medium">Email</label>
          <input
            type="email"
            className="input"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <label className="text-xs text-ink-muted font-medium">Username</label>
          <input
            className="input"
            required
            value={username}
            onChange={(e) => setU(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <label className="text-xs text-ink-muted font-medium">
            Password (min 8 chars)
          </label>
          <input
            type="password"
            className="input"
            required
            value={password}
            onChange={(e) => setP(e.target.value)}
          />
        </div>
        {err && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-sm text-danger bg-danger-soft border border-danger/20 rounded-lg px-3 py-2"
          >
            {err}
          </motion.div>
        )}
        <button
          disabled={busy}
          className="btn-primary w-full justify-center"
          type="submit"
        >
          {busy ? "Creating your account…" : "Create owner account"}
        </button>
      </motion.form>
    </div>
  );
}
