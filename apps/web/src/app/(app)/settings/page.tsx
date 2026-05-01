"use client";
import useSWR, { mutate } from "swr";
import { api, ApiError, fetcher } from "@/lib/api";
import { PageHeader } from "@/components/page-header";
import { AppearancePanel } from "@/components/appearance-switcher";
import { ImageUpload } from "@/components/image-upload";
import { User, Palette, Info, ImageIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";

type Me = {
  id: string;
  email: string;
  username: string;
  role: string;
  avatar: string | null;
};

export default function SettingsPage(): JSX.Element {
  const { data } = useSWR<Me>("/auth/me", fetcher);
  const { t } = useT();

  return (
    <div className="space-y-8 max-w-4xl">
      <PageHeader
        title={t("settings.title")}
        description={t("settings.subtitle")}
      />

      <Section icon={<User size={16} />} title={t("settings.account")}>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
          <Field label={t("settings.username")} value={data?.username} />
          <Field label={t("settings.email")} value={data?.email} />
          <Field label={t("settings.role")} value={data?.role} />
        </div>
      </Section>

      <Section icon={<ImageIcon size={16} />} title={t("settings.avatar")}>
        <AvatarEditor current={data?.avatar ?? null} />
      </Section>

      <Section icon={<Palette size={16} />} title={t("settings.appearance")}>
        <AppearancePanel />
      </Section>

      <Section icon={<Info size={16} />} title={t("settings.about")}>
        <div className="text-sm text-ink-secondary leading-relaxed">
          {t("settings.aboutText")}
        </div>
      </Section>
    </div>
  );
}

function AvatarEditor({ current }: { current: string | null }): JSX.Element {
  const { t } = useT();
  const [value, setValue] = useState<string | null>(current);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Sync local state with the prop whenever the upstream value
  // changes. `useState(current)` only uses its argument on the FIRST
  // render — if SWR hadn't resolved yet on mount (`current` was
  // null), `value` stays null forever even after the saved avatar
  // arrives, and the preview pretends there's no image. This is
  // exactly the "иногда пропадает хотя файл есть" bug the user hit.
  useEffect(() => {
    setValue(current);
  }, [current]);
  const dirty = value !== current;

  async function save(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      await api.patch("/auth/me", { avatar: value });
      await mutate("/auth/me");
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <ImageUpload
        value={value}
        onChange={setValue}
        targetSize={128}
        previewSize={96}
        shape="round"
      />
      {err && (
        <div className="text-sm text-[rgb(var(--danger))]">{err}</div>
      )}
      <div className="flex gap-2">
        <button
          className="btn btn-primary"
          onClick={save}
          disabled={!dirty || busy}
        >
          {busy ? t("integrations.saving") : t("settings.saveAvatar")}
        </button>
        {dirty && (
          <button
            className="btn btn-ghost"
            onClick={() => {
              setValue(current);
              setErr(null);
            }}
          >
            {t("common.cancel")}
          </button>
        )}
      </div>
    </div>
  );
}

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section className="tile p-7">
      <h2 className="heading-lg mb-6 flex items-center gap-2.5">
        <span className="w-8 h-8 rounded-md bg-[rgb(var(--accent-soft))] text-[rgb(var(--accent))] grid place-items-center">
          {icon}
        </span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Field({
  label,
  value,
}: {
  label: string;
  value?: string;
}): JSX.Element {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-ink-muted">
        {label}
      </div>
      <div className="text-sm text-ink mt-1">
        {value ?? <span className="text-ink-muted">—</span>}
      </div>
    </div>
  );
}
