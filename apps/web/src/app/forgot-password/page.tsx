"use client";
import { useState, type FormEvent } from "react";
import Link from "next/link";
import { api, ApiError } from "@/lib/api";
import { AuthShell } from "@/components/auth-shell";
import { LogoMark, Wordmark } from "@/components/logo";
import { useT } from "@/lib/i18n";

/**
 * Public "I forgot my password" form. POSTs to /auth/forgot-password,
 * which always returns 204 to prevent account enumeration. We show a
 * success copy regardless of whether the address actually exists in
 * the DB — the user is told to check email, and if they typo'd or
 * don't have an account, nothing happens server-side and nothing leaks.
 */
export default function ForgotPasswordPage(): JSX.Element {
  const { t } = useT();
  const [usernameOrEmail, setU] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.post("/auth/forgot-password", { usernameOrEmail });
      setSent(true);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
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
          <h1 className="heading-xl">{t("auth.forgot.title")}</h1>
          <p className="text-sm text-ink-secondary mt-1.5">
            {t("auth.forgot.subtitle")}
          </p>
        </div>

        {sent ? (
          <div className="space-y-3">
            <div className="tile p-4 text-sm text-ink-secondary">
              {t("auth.forgot.sent")}
            </div>
            <Link href="/login" className="btn btn-ghost w-full">
              {t("auth.forgot.backToLogin")}
            </Link>
          </div>
        ) : (
          <>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-ink-secondary">
                {t("auth.login.usernameOrEmail")}
              </label>
              <input
                className="input"
                autoFocus
                value={usernameOrEmail}
                onChange={(e) => setU(e.target.value)}
                required
              />
            </div>

            {err && (
              <div className="chip chip-danger !h-auto !py-2 !px-3">{err}</div>
            )}

            <button
              disabled={busy || !usernameOrEmail}
              className="btn btn-primary w-full"
              type="submit"
            >
              {busy ? t("auth.forgot.submitting") : t("auth.forgot.submit")}
            </button>
            <Link
              href="/login"
              className="block text-center text-sm link"
            >
              {t("auth.forgot.backToLogin")}
            </Link>
          </>
        )}
      </form>
    </AuthShell>
  );
}
