"use client";
import { motion } from "framer-motion";
import { useMemo, type ReactNode } from "react";
import { LogoMark, Wordmark } from "./logo";
import { useT } from "@/lib/i18n";
import { useMotionEnabled } from "@/lib/motion-pref";

/**
 * Split-screen auth layout: left-hand brand panel (gradient + grid),
 * right-hand content. Scales to single column on small screens.
 *
 * Decorative motion (drifting blocks behind the brand panel, breathing
 * blob, staggered form mount) is gated on the user's motion preference
 * so anyone with prefers-reduced-motion or an explicit "off" setting
 * sees the same layout statically.
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
  const motionEnabled = useMotionEnabled();
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
        {/* Soft glowing blob in the corner — slowly drifts when motion
            is enabled, stays put otherwise. */}
        <motion.span
          className="absolute -right-20 -bottom-20 w-[420px] h-[420px] rounded-full bg-white/10 blur-3xl"
          animate={
            motionEnabled
              ? { x: [0, 40, 0], y: [0, -20, 0], scale: [1, 1.1, 1] }
              : undefined
          }
          transition={
            motionEnabled
              ? { duration: 18, repeat: Infinity, ease: "easeInOut" }
              : undefined
          }
        />

        {motionEnabled && <FloatingBlocks />}

        <div className="relative flex items-center gap-3">
          <span className="w-10 h-10 rounded-lg bg-white/15 backdrop-blur-sm grid place-items-center ring-1 ring-white/25">
            <LogoMark size={22} />
          </span>
          <Wordmark className="text-sm text-white" />
        </div>

        <div className="relative space-y-6 max-w-md">
          <motion.h2
            className="text-3xl font-semibold tracking-tight leading-tight"
            initial={motionEnabled ? { opacity: 0, y: 14 } : false}
            animate={motionEnabled ? { opacity: 1, y: 0 } : undefined}
            transition={
              motionEnabled
                ? { duration: 0.5, delay: 0.1, ease: [0.2, 0.8, 0.2, 1] }
                : undefined
            }
          >
            {title}
          </motion.h2>
          <motion.p
            className="text-base text-white/80 leading-relaxed"
            initial={motionEnabled ? { opacity: 0, y: 10 } : false}
            animate={motionEnabled ? { opacity: 1, y: 0 } : undefined}
            transition={
              motionEnabled
                ? { duration: 0.5, delay: 0.22, ease: [0.2, 0.8, 0.2, 1] }
                : undefined
            }
          >
            {subtitle}
          </motion.p>
          {quote && (
            <motion.figure
              className="border-l-2 border-white/30 pl-4 mt-8"
              initial={motionEnabled ? { opacity: 0, x: -8 } : false}
              animate={motionEnabled ? { opacity: 1, x: 0 } : undefined}
              transition={
                motionEnabled
                  ? { duration: 0.5, delay: 0.34, ease: [0.2, 0.8, 0.2, 1] }
                  : undefined
              }
            >
              <blockquote className="text-sm italic text-white/90">
                "{quote}"
              </blockquote>
              {cite && (
                <figcaption className="text-xs text-white/60 mt-1">
                  — {cite}
                </figcaption>
              )}
            </motion.figure>
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
          initial={motionEnabled ? { opacity: 0, y: 12 } : false}
          animate={motionEnabled ? { opacity: 1, y: 0 } : undefined}
          transition={
            motionEnabled
              ? { duration: 0.35, ease: [0.2, 0.8, 0.2, 1] }
              : undefined
          }
          className="w-full max-w-[400px]"
        >
          {children}
        </motion.div>
      </div>
    </div>
  );
}

/**
 * Eight semi-transparent Minecraft-style blocks that drift up the
 * brand panel, fading in/out as they cross the viewport. Pure
 * decoration — `pointer-events-none` so they never intercept clicks.
 *
 * Positions and timings are deterministic (seeded constants below) so
 * SSR/CSR hydration matches and the layout doesn't visually shift on
 * mount.
 */
function FloatingBlocks(): JSX.Element {
  const blocks = useMemo(
    () => [
      { x: "8%", size: 38, duration: 24, delay: 0, rotate: 28 },
      { x: "22%", size: 22, duration: 30, delay: 6, rotate: -18 },
      { x: "38%", size: 52, duration: 36, delay: 12, rotate: 12 },
      { x: "56%", size: 30, duration: 28, delay: 3, rotate: 40 },
      { x: "72%", size: 44, duration: 32, delay: 9, rotate: -22 },
      { x: "84%", size: 26, duration: 26, delay: 15, rotate: 18 },
      { x: "14%", size: 18, duration: 34, delay: 19, rotate: -8 },
      { x: "64%", size: 36, duration: 38, delay: 22, rotate: 30 },
    ],
    []
  );
  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden">
      {blocks.map((b, i) => (
        <motion.span
          key={i}
          className="absolute rounded-[3px] bg-white/15 ring-1 ring-white/20"
          style={{
            left: b.x,
            width: b.size,
            height: b.size,
          }}
          initial={{ y: "120vh", opacity: 0, rotate: 0 }}
          animate={{
            y: "-30vh",
            opacity: [0, 0.45, 0.45, 0],
            rotate: b.rotate,
          }}
          transition={{
            duration: b.duration,
            delay: b.delay,
            repeat: Infinity,
            ease: "linear",
          }}
        />
      ))}
    </div>
  );
}
