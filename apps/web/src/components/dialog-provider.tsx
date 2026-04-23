"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n";

/**
 * Panel-native replacements for window.alert / window.confirm that match
 * the tile / chip / button theming. Returned promises resolve when the
 * user clicks something (or presses Enter / Escape).
 *
 * Also exposes `toast(...)` for non-blocking "Saved." style notifications.
 */

type Tone = "info" | "success" | "warning" | "danger";

type AlertOpts = {
  title?: string;
  message?: React.ReactNode;
  tone?: Tone;
  okLabel?: string;
};

type ConfirmOpts = AlertOpts & {
  cancelLabel?: string;
  danger?: boolean; // styles OK as danger button
};

type ToastOpts = {
  message: string;
  tone?: Tone;
  duration?: number;
};

type DialogApi = {
  alert: (opts: AlertOpts | string) => Promise<void>;
  confirm: (opts: ConfirmOpts | string) => Promise<boolean>;
  toast: (opts: ToastOpts | string) => void;
};

const DialogContext = createContext<DialogApi | null>(null);

type ModalState =
  | ({
      kind: "alert";
      resolve: () => void;
    } & Required<Pick<AlertOpts, "tone">> &
      AlertOpts)
  | ({
      kind: "confirm";
      resolve: (v: boolean) => void;
    } & Required<Pick<ConfirmOpts, "tone">> &
      ConfirmOpts);

type ToastState = {
  id: number;
  message: string;
  tone: Tone;
  duration: number;
};

export function DialogProvider({
  children,
}: {
  children: React.ReactNode;
}): JSX.Element {
  const [modal, setModal] = useState<ModalState | null>(null);
  const [toasts, setToasts] = useState<ToastState[]>([]);
  const toastIdRef = useRef(1);
  const { t } = useT();

  const alert = useCallback<DialogApi["alert"]>((opts) => {
    const o: AlertOpts = typeof opts === "string" ? { message: opts } : opts;
    return new Promise<void>((resolve) => {
      setModal({
        kind: "alert",
        tone: o.tone ?? "info",
        ...o,
        resolve,
      });
    });
  }, []);

  const confirm = useCallback<DialogApi["confirm"]>((opts) => {
    const o: ConfirmOpts = typeof opts === "string" ? { message: opts } : opts;
    return new Promise<boolean>((resolve) => {
      setModal({
        kind: "confirm",
        tone: o.tone ?? (o.danger ? "danger" : "info"),
        ...o,
        resolve,
      });
    });
  }, []);

  const toast = useCallback<DialogApi["toast"]>((opts) => {
    const o: ToastOpts = typeof opts === "string" ? { message: opts } : opts;
    const id = toastIdRef.current++;
    const state: ToastState = {
      id,
      message: o.message,
      tone: o.tone ?? "info",
      duration: o.duration ?? 3500,
    };
    setToasts((prev) => [...prev, state]);
    setTimeout(
      () => setToasts((prev) => prev.filter((x) => x.id !== id)),
      state.duration
    );
  }, []);

  const api = useMemo<DialogApi>(
    () => ({ alert, confirm, toast }),
    [alert, confirm, toast]
  );

  function close(result?: boolean): void {
    if (!modal) return;
    if (modal.kind === "alert") modal.resolve();
    else modal.resolve(Boolean(result));
    setModal(null);
  }

  // Esc = cancel, Enter = confirm. Only binds while a modal is open.
  useEffect(() => {
    if (!modal) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        e.preventDefault();
        close(false);
      } else if (e.key === "Enter") {
        e.preventDefault();
        close(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modal]);

  return (
    <DialogContext.Provider value={api}>
      {children}

      <AnimatePresence>
        {modal && (
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm grid place-items-center p-4"
            onClick={(e) => {
              // click outside = cancel/close
              if (e.target === e.currentTarget) close(false);
            }}
          >
            <motion.div
              key="modal"
              initial={{ opacity: 0, scale: 0.96, y: 6 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.97, y: 2 }}
              transition={{ duration: 0.16, ease: "easeOut" }}
              role="dialog"
              aria-modal="true"
              className="surface-raised w-full max-w-md shadow-[var(--shadow-popover)]"
            >
              <div className="p-5 flex gap-3 items-start">
                <ToneIcon tone={modal.tone} />
                <div className="flex-1 min-w-0">
                  {modal.title && (
                    <h3 className="heading-md">{modal.title}</h3>
                  )}
                  {modal.message && (
                    <div className="text-sm text-ink-secondary mt-1.5 leading-relaxed whitespace-pre-line">
                      {modal.message}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className="btn-icon btn-ghost !h-8 !w-8 shrink-0"
                  aria-label={t("common.close")}
                  onClick={() => close(false)}
                >
                  <X size={14} />
                </button>
              </div>
              <div className="flex items-center justify-end gap-2 p-3 border-t border-line bg-[rgb(var(--bg-surface-2))]/50">
                {modal.kind === "confirm" && (
                  <button
                    className="btn btn-ghost"
                    onClick={() => close(false)}
                  >
                    {modal.cancelLabel ?? t("common.cancel")}
                  </button>
                )}
                <button
                  className={cn(
                    modal.kind === "confirm" &&
                      (modal as ConfirmOpts).danger
                      ? "btn btn-danger"
                      : "btn btn-primary"
                  )}
                  onClick={() => close(true)}
                  autoFocus
                >
                  {modal.okLabel ?? t("common.ok")}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Toast stack */}
      <div className="fixed bottom-5 right-5 z-[101] flex flex-col gap-2 items-end pointer-events-none">
        <AnimatePresence>
          {toasts.map((ts) => (
            <motion.div
              key={ts.id}
              initial={{ opacity: 0, y: 12, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, x: 30, scale: 0.95 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              className={cn(
                "surface-raised pointer-events-auto shadow-[var(--shadow-popover)] px-4 py-3 text-sm flex items-center gap-3 max-w-[380px]"
              )}
            >
              <ToneIcon tone={ts.tone} small />
              <span className="flex-1">{ts.message}</span>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </DialogContext.Provider>
  );
}

function ToneIcon({
  tone,
  small,
}: {
  tone: Tone;
  small?: boolean;
}): JSX.Element {
  const size = small ? 14 : 18;
  const map: Record<
    Tone,
    { bg: string; fg: string; Icon: React.ComponentType<any> }
  > = {
    info: {
      bg: "bg-[rgb(var(--accent-soft))]",
      fg: "text-[rgb(var(--accent))]",
      Icon: Info,
    },
    success: {
      bg: "bg-[rgb(var(--success-soft))]",
      fg: "text-[rgb(var(--success))]",
      Icon: CheckCircle2,
    },
    warning: {
      bg: "bg-[rgb(var(--warning-soft))]",
      fg: "text-[rgb(var(--warning))]",
      Icon: AlertTriangle,
    },
    danger: {
      bg: "bg-[rgb(var(--danger-soft))]",
      fg: "text-[rgb(var(--danger))]",
      Icon: XCircle,
    },
  };
  const { bg, fg, Icon } = map[tone];
  return (
    <span
      className={cn(
        "rounded-md grid place-items-center shrink-0",
        bg,
        fg,
        small ? "w-6 h-6" : "w-8 h-8"
      )}
    >
      <Icon size={size} />
    </span>
  );
}

export function useDialog(): DialogApi {
  const ctx = useContext(DialogContext);
  if (!ctx) {
    throw new Error("useDialog must be used inside <DialogProvider>");
  }
  return ctx;
}
