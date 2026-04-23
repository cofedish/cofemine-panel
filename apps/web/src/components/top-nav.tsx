"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { cn } from "@/lib/cn";
import { LogoMark, Wordmark } from "./logo";
import { UserMenu } from "./user-menu";
import { useT } from "@/lib/i18n";

const LINKS = [
  { href: "/", key: "nav.dashboard" },
  { href: "/infrastructure", key: "nav.infrastructure" },
  { href: "/integrations", key: "nav.integrations" },
  { href: "/administration", key: "nav.administration" },
] as const;

/**
 * Top navigation. Horizontal, sticky, backdrop-blurred. On mobile the
 * links wrap to a secondary row below the brand/user row.
 */
export function TopNav(): JSX.Element {
  const pathname = usePathname() ?? "/";
  const { t } = useT();

  return (
    <header className="sticky top-0 z-40 bg-[rgb(var(--bg-base))]/80 backdrop-blur-xl border-b border-line">
      <div className="max-w-[1400px] mx-auto px-6 h-14 flex items-center gap-4">
        <Link href="/" className="flex items-center gap-2.5 shrink-0">
          <span className="w-8 h-8 rounded-lg bg-[rgb(var(--accent-soft))] text-[rgb(var(--accent))] grid place-items-center">
            <LogoMark size={20} />
          </span>
          <Wordmark className="text-[12px] hidden sm:inline" />
        </Link>

        <nav className="hidden md:flex items-center gap-0.5 ml-4">
          {LINKS.map((l) => {
            const active =
              l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                className={cn(
                  "relative px-3.5 py-1.5 rounded-md text-sm font-medium transition-colors",
                  active
                    ? "text-ink"
                    : "text-ink-secondary hover:text-ink"
                )}
              >
                {active && (
                  <motion.span
                    layoutId="top-nav-active"
                    className="absolute inset-0 rounded-md bg-surface-2"
                    transition={{ type: "spring", duration: 0.35, bounce: 0.15 }}
                  />
                )}
                <span className="relative z-10">{t(l.key)}</span>
              </Link>
            );
          })}
        </nav>

        <div className="flex-1" />

        <div className="flex items-center gap-3">
          <UserMenu />
        </div>
      </div>

      {/* Mobile secondary row */}
      <nav className="md:hidden border-t border-line px-3 h-11 flex items-center gap-1 overflow-x-auto">
        {LINKS.map((l) => {
          const active =
            l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
          return (
            <Link
              key={l.href}
              href={l.href}
              className={cn(
                "px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors",
                active
                  ? "bg-surface-2 text-ink"
                  : "text-ink-secondary hover:text-ink hover:bg-surface-2"
              )}
            >
              {t(l.key)}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
