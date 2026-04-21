"use client";
import useSWR from "swr";
import { fetcher } from "@/lib/api";
import { AppearancePanel } from "@/components/appearance-switcher";
import { User, Palette, Info } from "lucide-react";

type Me = { id: string; email: string; username: string; role: string };

export default function SettingsPage(): JSX.Element {
  const { data } = useSWR<Me>("/auth/me", fetcher);

  return (
    <div className="space-y-8 max-w-3xl">
      <header>
        <h1 className="heading-xl">Settings</h1>
        <p className="text-ink-secondary mt-2">
          Personal preferences and appearance.
        </p>
      </header>

      <Section icon={<User size={16} />} title="Account">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
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
          <b className="text-ink">Cofemine Panel</b> v0.1.0 — self-hosted
          Docker-first Minecraft control panel. Source in{" "}
          <code>docs/</code> covers architecture, deployment, API and
          security model.
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
    <section className="card p-6">
      <h2 className="heading-lg mb-5 flex items-center gap-2">
        <span className="w-7 h-7 rounded-md bg-accent-soft text-accent grid place-items-center">
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
