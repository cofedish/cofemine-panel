"use client";
import { motion } from "framer-motion";
import type { ReactNode } from "react";
import { LogoMark, Wordmark } from "./logo";
import { useT } from "@/lib/i18n";

/**
 * Split-screen auth layout: left-hand brand panel (gradient + grid),
 * right-hand content. Scales to single column on small screens.
 */
export function AuthShell({
  children,
  title,
  subtitle,
  quote,
  cite,
}: {
  children: ReactNode;
  title: ReactNode;
  subtitle: ReactNode;
  quote?: string;
  cite?: string;
}): JSX.Element {
  const { t } = useT();
  return (
    <div className="min-h-screen flex">
      {/* Brand panel */}
      <aside
        className="hidden lg:flex w-1/2 p-10 flex-col justify-between relative overflow-hidden text-white"
        style={{
          background:
            "linear-gradient(135deg, rgb(var(--accent-hover)) 0%, rgb(var(--accent)) 100%)",
        }}
      >
        <span className="absolute inset-0 bg-grid-pattern opacity-20" />
        <span className="absolute -right-20 -bottom-20 w-[420px] h-[420px] rounded-full bg-white/10 blur-3xl" />

        <div className="relative flex items-center gap-3">
          <span className="w-10 h-10 rounded-lg bg-white/15 backdrop-blur-sm grid place-items-center ring-1 ring-white/25">
            <LogoMark size={22} />
          </span>
          <Wordmark className="text-xl text-white" />
        </div>

        <div className="relative space-y-6 max-w-md">
          <h2 className="text-3xl font-semibold tracking-tight leading-tight">
            {title}
          </h2>
          <p className="text-base text-white/80 leading-relaxed">{subtitle}</p>
          {quote && (
            <figure className="border-l-2 border-white/30 pl-4 mt-8">
              <blockquote className="text-sm italic text-white/90">
                "{quote}"
              </blockquote>
              {cite && (
                <figcaption className="text-xs text-white/60 mt-1">
                  — {cite}
                </figcaption>
              )}
            </figure>
          )}
        </div>

        <div className="relative text-xs text-white/60 flex items-center gap-4">
          <span>{t("auth.shell.footer")}</span>
          <span>v0.1.0</span>
        </div>
      </aside>

      {/* Content */}
      <div className="flex-1 flex items-center justify-center p-6 relative">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: [0.2, 0.8, 0.2, 1] }}
          className="w-full max-w-[400px]"
        >
          {children}
        </motion.div>
      </div>
    </div>
  );
}
