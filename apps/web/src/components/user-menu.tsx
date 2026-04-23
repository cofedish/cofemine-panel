"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import useSWR from "swr";
import { api, fetcher } from "@/lib/api";
import { LogOut, Settings, Sun, Moon, Monitor, Languages } from "lucide-react";
import { useTheme } from "next-themes";
import { cn } from "@/lib/cn";
import { Avatar } from "./avatar";
import { useT, type Lang } from "@/lib/i18n";

type Me = {
  id: string;
  email: string;
  username: string;
  role: string;
  avatar: string | null;
};

export function UserMenu(): JSX.Element {
  const { data } = useSWR<Me>("/auth/me", fetcher);
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { theme, setTheme } = useTheme();
  const { lang, setLang, t } = useT();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    function onDoc(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  async function logout(): Promise<void> {
    await api.post("/auth/logout").catch(() => {});
    router.push("/login");
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 pl-1.5 pr-3 h-9 rounded-full border border-line hover:bg-surface-2 transition-colors"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Avatar src={data?.avatar} name={data?.username} size={24} />
        <span className="text-sm font-medium max-w-[120px] truncate">
          {data?.username ?? "…"}
        </span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.14, ease: "easeOut" }}
            className="absolute right-0 top-[calc(100%+8px)] w-64 surface-raised p-1.5 shadow-[var(--shadow-popover)] z-50"
          >
            <div className="px-3 py-2.5 flex items-center gap-3 border-b border-line mb-1">
              <Avatar src={data?.avatar} name={data?.username} size={36} />
              <div className="min-w-0">
                <div className="text-sm font-semibold truncate">
                  {data?.username}
                </div>
                <div className="text-xs text-ink-muted truncate">
                  {data?.email}
                </div>
              </div>
              <span className="chip chip-accent ml-auto">{data?.role}</span>
            </div>

            <div className="px-2 pt-1 pb-0.5 text-[10px] uppercase tracking-wider text-ink-muted">
              Theme
            </div>
            <div className="grid grid-cols-3 gap-1 p-1">
              {(
                [
                  { v: "light", label: "Light", Icon: Sun },
                  { v: "dark", label: "Dark", Icon: Moon },
                  { v: "system", label: "System", Icon: Monitor },
                ] as const
              ).map(({ v, label, Icon }) => (
                <button
                  key={v}
                  onClick={() => setTheme(v)}
                  className={cn(
                    "flex flex-col items-center gap-1 py-2 rounded-md text-[11px] border transition-colors",
                    mounted && theme === v
                      ? "border-[rgb(var(--accent))]/60 bg-[rgb(var(--accent-soft))]/60 text-[rgb(var(--accent))]"
                      : "border-transparent hover:bg-surface-2 text-ink-secondary"
                  )}
                >
                  <Icon size={14} />
                  {label}
                </button>
              ))}
            </div>

            <div className="px-2 pt-2 pb-0.5 text-[10px] uppercase tracking-wider text-ink-muted flex items-center gap-1.5">
              <Languages size={10} /> {t("lang.label")}
            </div>
            <div className="grid grid-cols-2 gap-1 p-1">
              {(
                [
                  { v: "en", label: t("lang.en") },
                  { v: "ru", label: t("lang.ru") },
                ] as const
              ).map(({ v, label }) => (
                <button
                  key={v}
                  onClick={() => setLang(v as Lang)}
                  className={cn(
                    "py-2 rounded-md text-xs border transition-colors",
                    lang === v
                      ? "border-[rgb(var(--accent))]/60 bg-[rgb(var(--accent-soft))]/60 text-[rgb(var(--accent))]"
                      : "border-transparent hover:bg-surface-2 text-ink-secondary"
                  )}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="divider my-1" />

            <MenuItem href="/settings" icon={<Settings size={14} />} onClick={() => setOpen(false)}>
              Settings
            </MenuItem>
            <MenuButton icon={<LogOut size={14} />} onClick={logout} danger>
              Sign out
            </MenuButton>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function MenuItem({
  href,
  icon,
  children,
  onClick,
}: {
  href: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  onClick?: () => void;
}): JSX.Element {
  return (
    <Link
      href={href}
      onClick={onClick}
      className="flex items-center gap-2.5 px-2.5 py-2 text-sm rounded-md text-ink-secondary hover:text-ink hover:bg-surface-2 transition-colors"
    >
      <span className="text-ink-muted">{icon}</span>
      {children}
    </Link>
  );
}

function MenuButton({
  icon,
  children,
  onClick,
  danger,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  onClick?: () => void;
  danger?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-2.5 px-2.5 py-2 text-sm rounded-md transition-colors",
        danger
          ? "text-[rgb(var(--danger))] hover:bg-[rgb(var(--danger-soft))]"
          : "text-ink-secondary hover:text-ink hover:bg-surface-2"
      )}
    >
      <span className={danger ? "text-[rgb(var(--danger))]" : "text-ink-muted"}>
        {icon}
      </span>
      {children}
    </button>
  );
}
