"use client";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Right-side slide-in drawer. Used for secondary flows (e.g. invite user,
 * node details) without taking the user off the current page.
 */
export function Drawer({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 440,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}): JSX.Element {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
            className="fixed inset-0 bg-black/30 backdrop-blur-[2px] z-30"
            onClick={onClose}
          />
          <motion.aside
            key="panel"
            initial={{ x: width }}
            animate={{ x: 0 }}
            exit={{ x: width }}
            transition={{ type: "spring", damping: 26, stiffness: 260 }}
            style={{ width }}
            // Top nav (h-14) stays visible on top (z-40). Drawer sits
            // below it so the brand/nav/user menu remain reachable.
            className="fixed right-0 top-14 bottom-0 bg-[rgb(var(--bg-surface-1))] border-l border-t border-line z-30 flex flex-col shadow-[var(--shadow-lg)]"
          >
            <header className="flex items-start gap-3 p-5 border-b border-line">
              <div className="flex-1 min-w-0">
                <h2 className="heading-lg truncate">{title}</h2>
                {description && (
                  <p className="text-sm text-ink-muted mt-1">{description}</p>
                )}
              </div>
              <button
                onClick={onClose}
                aria-label="Close"
                className={cn(
                  "btn btn-ghost btn-icon !h-9 !w-9 !p-0"
                )}
              >
                <X size={16} />
              </button>
            </header>
            <div className="flex-1 overflow-y-auto p-5">{children}</div>
            {footer && (
              <footer className="border-t border-line p-4 flex justify-end gap-2">
                {footer}
              </footer>
            )}
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
