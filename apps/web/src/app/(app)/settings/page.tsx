"use client";
import useSWR from "swr";
import { fetcher } from "@/lib/api";
import { PageHeader } from "@/components/page-header";
import { AppearancePanel } from "@/components/appearance-switcher";
import { User, Palette, Info } from "lucide-react";

type Me = { id: string; email: string; username: string; role: string };

export default function SettingsPage(): JSX.Element {
  const { data } = useSWR<Me>("/auth/me", fetcher);

  return (
    <div className="space-y-8 max-w-4xl">
      <PageHeader
        title="Settings"
        description="Personal preferences and appearance."
      />

      <Section icon={<User size={16} />} title="Account">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
          <Field label="Username" value={data?.username} />
          <Field label="Email" value={data?.email} />
          <Field label="Role" value={data?.role} />
        </div>
      </Section>

      <Section icon={<Palette size={16} />} title="Appearance">
        <AppearancePanel />
      </Section>

      <Section icon={<Info size={16} />} title="About">
        <div className="text-sm text-ink-secondary leading-relaxed">
          <b className="text-ink">Cofemine Panel</b> v0.1.0 — self-hosted,
          Docker-first Minecraft control panel. See the <code className="kbd">docs/</code>{" "}
          folder for architecture, deployment, API reference and the security
          model.
        </div>
      </Section>
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
