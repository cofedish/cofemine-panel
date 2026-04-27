"use client";
import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { AuthShell } from "@/components/auth-shell";
import { LogoMark, Wordmark } from "@/components/logo";
import { useT } from "@/lib/i18n";

/**
 * Consumes a reset link. The token comes in via ?token=… ; the user only
 * has to type the new password (twice for confirmation). On success we
 * redirect to /login because the API has invalidated all sessions, so
 * the user has to authenticate fresh anyway.
 */
export default function ResetPasswordPage(): JSX.Element {
  const router = useRouter();
  const params = useSearchParams();
  const token = params?.get("token") ?? "";
  const { t } = useT();
  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setErr(null);
    if (pass !== confirm) {
      setErr(t("auth.reset.mismatch"));
      return;
    }
    setBusy(true);
    try {
      await api.post("/auth/reset-password", {
        token,
        newPassword: pass,
      });
      setDone(true);
      setTimeout(() => router.push("/login"), 1500);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <AuthShell
        title={t("auth.shell.title")}
        subtitle={t("auth.shell.subtitle")}
      >
        <div className="space-y-4">
          <h1 className="heading-xl">{t("auth.reset.invalidTitle")}</h1>
          <p className="text-sm text-ink-secondary">
            {t("auth.reset.missingToken")}
          </p>
          <Link href="/forgot-password" className="btn btn-primary w-full">
            {t("auth.reset.requestNew")}
          </Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={t("auth.shell.title")}
      subtitle={t("auth.shell.subtitle")}
      quote={t("auth.shell.quote")}
      cite={t("auth.shell.cite")}
    >
      <form onSubmit={submit} className="space-y-5">
        <div className="lg:hidden flex items-center gap-2.5 mb-2">
          <span className="w-9 h-9 rounded-lg bg-[rgb(var(--accent-soft))] text-[rgb(var(--accent))] grid place-items-center">
            <LogoMark size={22} />
          </span>
          <Wordmark className="text-sm" />
        </div>

        <div>
          <h1 className="heading-xl">{t("auth.reset.title")}</h1>
          <p className="text-sm text-ink-secondary mt-1.5">
            {t("auth.reset.subtitle")}
          </p>
        </div>

        {done ? (
          <div className="tile p-4 text-sm text-ink-secondary">
            {t("auth.reset.success")}
          </div>
        ) : (
          <>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-ink-secondary">
                {t("auth.reset.newPassword")}
              </label>
              <input
                className="input"
                type="password"
                value={pass}
                onChange={(e) => setPass(e.target.value)}
                minLength={8}
                required
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-ink-secondary">
                {t("auth.reset.confirmPassword")}
              </label>
              <input
                className="input"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                minLength={8}
                required
              />
              <div className="text-xs text-ink-muted">
                {t("setup.passwordHint")}
              </div>
            </div>

            {err && (
              <div className="chip chip-danger !h-auto !py-2 !px-3">{err}</div>
            )}

            <button
              disabled={busy || !pass || !confirm}
              className="btn btn-primary w-full"
              type="submit"
            >
              {busy ? t("auth.reset.submitting") : t("auth.reset.submit")}
            </button>
          </>
        )}
      </form>
    </AuthShell>
  );
}
