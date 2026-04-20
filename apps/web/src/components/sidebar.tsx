"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import {
  LayoutDashboard,
  Server,
  Users,
  ClipboardList,
  Layers,
  Plug,
  HardDrive,
  Settings,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { LogoMark, Wordmark } from "./logo";

const links = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/servers", label: "Servers", icon: Server },
  { href: "/nodes", label: "Nodes", icon: HardDrive },
  { href: "/templates", label: "Templates", icon: Layers },
  { href: "/users", label: "Users", icon: Users },
  { href: "/audit", label: "Audit log", icon: ClipboardList },
  { href: "/integrations", label: "Integrations", icon: Plug },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Sidebar(): JSX.Element {
  const pathname = usePathname();
  return (
    <aside className="w-64 shrink-0 h-screen sticky top-0 flex flex-col bg-surface-1/70 backdrop-blur-xl border-r border-line">
      <div className="px-5 py-5 border-b border-line">
        <Link href="/" className="flex items-center gap-2.5 group">
          <span className="relative flex items-center justify-center w-9 h-9 rounded-lg bg-accent-soft text-ink block-accent animate-subtle-bob">
            <LogoMark size={22} />
          </span>
          <span className="flex flex-col leading-tight">
            <Wordmark className="text-lg" />
            <span className="text-[10px] uppercase tracking-[0.18em] text-ink-muted">
              Minecraft control
            </span>
          </span>
        </Link>
      </div>
      <nav className="flex-1 py-3 px-2 space-y-0.5">
        {links.map((l) => {
          const active =
            l.href === "/"
              ? pathname === "/"
              : pathname?.startsWith(l.href);
          const Icon = l.icon;
          return (
            <Link
              key={l.href}
              href={l.href}
              className={cn(
                "relative flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors",
                active
                  ? "text-ink"
                  : "text-ink-secondary hover:text-ink hover:bg-surface-2"
              )}
            >
              {active && (
                <motion.span
                  layoutId="sidebar-active"
                  className="absolute inset-0 rounded-lg bg-accent-soft"
                  transition={{ type: "spring", duration: 0.38, bounce: 0.12 }}
                />
              )}
              <Icon
                size={16}
                className={cn(
                  "relative z-10 transition-colors",
                  active ? "text-accent" : "text-ink-muted"
                )}
              />
              <span className="relative z-10 font-medium">{l.label}</span>
            </Link>
          );
        })}
      </nav>
      <div className="px-5 py-3 text-[11px] text-ink-muted border-t border-line">
        v0.1.0 MVP · dark/light
      </div>
    </aside>
  );
}
