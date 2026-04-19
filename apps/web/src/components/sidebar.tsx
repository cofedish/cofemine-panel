"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
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
    <aside className="w-60 shrink-0 bg-surface-1 border-r border-surface-border h-screen sticky top-0 flex flex-col">
      <div className="px-5 py-5 border-b border-surface-border">
        <div className="font-semibold text-lg tracking-tight">
          <span className="text-accent">cofemine</span> panel
        </div>
        <div className="text-xs text-zinc-500 mt-0.5">Minecraft control</div>
      </div>
      <nav className="flex-1 py-3 px-2 space-y-1">
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
                "flex items-center gap-3 px-3 py-2 rounded-md text-sm text-zinc-300",
                active
                  ? "bg-surface-3 text-white"
                  : "hover:bg-surface-2 hover:text-white"
              )}
            >
              <Icon size={16} />
              {l.label}
            </Link>
          );
        })}
      </nav>
      <div className="px-5 py-3 text-xs text-zinc-500 border-t border-surface-border">
        v0.1.0 MVP
      </div>
    </aside>
  );
}
