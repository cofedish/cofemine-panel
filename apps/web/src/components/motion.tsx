"use client";
import { motion, type MotionProps } from "framer-motion";
import type { ReactNode } from "react";

const ease = [0.2, 0.8, 0.2, 1] as const;

/** Gentle page-level fade-in. Respects prefers-reduced-motion automatically. */
export function PageFade({ children }: { children: ReactNode }): JSX.Element {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.32, ease }}
    >
      {children}
    </motion.div>
  );
}

/** Stagger container for lists of cards. */
export function Stagger({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <motion.div
      className={className}
      initial="hidden"
      animate="visible"
      variants={{
        hidden: {},
        visible: { transition: { staggerChildren: 0.04, delayChildren: 0.05 } },
      }}
    >
      {children}
    </motion.div>
  );
}

/** An item inside <Stagger>. */
export function StaggerItem({
  children,
  className,
  ...rest
}: {
  children: ReactNode;
  className?: string;
} & MotionProps): JSX.Element {
  return (
    <motion.div
      className={className}
      variants={{
        hidden: { opacity: 0, y: 8 },
        visible: { opacity: 1, y: 0, transition: { duration: 0.26, ease } },
      }}
      {...rest}
    >
      {children}
    </motion.div>
  );
}
