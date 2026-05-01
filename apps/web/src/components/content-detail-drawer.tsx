"use client";

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import useSWR from "swr";
import {
  X,
  Download,
  ExternalLink,
  Package,
  Calendar,
  Tag,
  Check,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { fetcher } from "@/lib/api";
import { cn } from "@/lib/cn";
import { ModrinthMark, CurseForgeMark } from "./brand-icons";
import { useT } from "@/lib/i18n";

type Provider = "modrinth" | "curseforge";

type GalleryItem = {
  url: string;
  title?: string;
  description?: string;
  featured?: boolean;
};

type ContentDetails = {
  id: string;
  provider: Provider;
  name: string;
  slug?: string;
  description?: string;
  author?: string;
  iconUrl?: string;
  pageUrl?: string;
  downloads?: number;
  followers?: number;
  body?: string;
  bodyFormat?: "markdown" | "html";
  gallery?: GalleryItem[];
  links?: Array<{ label: string; url: string }>;
  categories?: string[];
  publishedAt?: string;
  updatedAt?: string;
  license?: string;
  loaders?: string[];
  gameVersions?: string[];
  clientSide?: string;
  serverSide?: string;
};

/**
 * Slide-up modal showing the full mod / modpack page inside the panel —
 * markdown (Modrinth) or sanitised HTML (CurseForge) body, gallery, link
 * row, version + loader chips, install button. Replaces the "open page
 * on modrinth.com" external redirect for the common case.
 */
export function ContentDetailDrawer({
  open,
  onClose,
  provider,
  projectId,
  initial,
  installed,
  installing,
  onInstall,
  actionLabel,
  extra,
  actionDisabled,
}: {
  open: boolean;
  onClose: () => void;
  provider: Provider;
  projectId: string;
  /** Optional summary we already have from the search list — used as a
   *  skeleton placeholder while the full payload is fetched. */
  initial?: Partial<ContentDetails>;
  installed?: boolean;
  installing?: boolean;
  onInstall?: () => void;
  /** Override the action button label (default: "Install"). Useful when
   *  reusing the drawer in a wizard where the action means "pick this". */
  actionLabel?: string;
  /** Caller-supplied node rendered before the long-form body — used to
   *  inline secondary controls like a version picker so the user doesn't
   *  have to dismiss the drawer to keep moving. */
  extra?: React.ReactNode;
  /** Disable the action button (e.g. version not yet picked). */
  actionDisabled?: boolean;
}): JSX.Element {
  const { t } = useT();
  const { data, error } = useSWR<ContentDetails>(
    open ? `/integrations/${provider}/projects/${projectId}/details` : null,
    fetcher,
    { revalidateOnFocus: false }
  );

  // ESC closes
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const merged: Partial<ContentDetails> = { ...initial, ...(data ?? {}) };
  const loading = !data && !error;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="scrim"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          className="fixed inset-0 z-[80] bg-black/50 backdrop-blur-sm grid place-items-center p-4 sm:p-8"
          onClick={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
        >
          <motion.div
            key="panel"
            initial={{ opacity: 0, y: 24, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.98 }}
            transition={{ type: "spring", damping: 28, stiffness: 280 }}
            role="dialog"
            aria-modal="true"
            className="surface-raised w-full max-w-3xl max-h-[90vh] flex flex-col shadow-[var(--shadow-popover)] overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <DetailHeader
              data={merged}
              provider={provider}
              loading={loading}
              onClose={onClose}
            />
            <div className="flex-1 overflow-y-auto">
              {error ? (
                <div className="p-8 text-sm text-[rgb(var(--danger))]">
                  {String((error as Error).message ?? error)}
                </div>
              ) : (
                <DetailBody
                  data={merged}
                  loading={loading}
                  extra={extra}
                />
              )}
            </div>
            <footer className="border-t border-line p-4 flex items-center justify-between gap-3 flex-wrap">
              <div className="text-xs text-ink-muted flex items-center gap-3 flex-wrap">
                {merged.updatedAt && (
                  <span className="inline-flex items-center gap-1">
                    <Calendar size={11} />
                    {formatDate(merged.updatedAt)}
                  </span>
                )}
                {merged.license && (
                  <span className="inline-flex items-center gap-1">
                    <Tag size={11} />
                    {merged.license}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {merged.pageUrl && (
                  <a
                    className="btn btn-ghost"
                    href={merged.pageUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {provider === "modrinth" ? "Modrinth" : "CurseForge"}{" "}
                    <ExternalLink size={12} />
                  </a>
                )}
                {onInstall && (
                  <button
                    className={cn(
                      "btn",
                      installed ? "btn-ghost" : "btn-primary"
                    )}
                    onClick={onInstall}
                    disabled={installing || installed || actionDisabled}
                  >
                    {installed ? (
                      <>
                        <Check size={14} /> {t("content.installedBadge")}
                      </>
                    ) : installing ? (
                      t("content.installing")
                    ) : (
                      actionLabel ?? t("content.install")
                    )}
                  </button>
                )}
              </div>
            </footer>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function DetailHeader({
  data,
  provider,
  loading,
  onClose,
}: {
  data: Partial<ContentDetails>;
  provider: Provider;
  loading: boolean;
  onClose: () => void;
}): JSX.Element {
  return (
    <header className="relative p-5 border-b border-line flex gap-4 items-start">
      {data.iconUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={data.iconUrl}
          alt=""
          className="w-16 h-16 rounded-lg object-cover bg-surface-2 flex-shrink-0"
          draggable={false}
        />
      ) : (
        <span className="w-16 h-16 rounded-lg bg-surface-2 grid place-items-center text-ink-secondary flex-shrink-0">
          <Package size={28} />
        </span>
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <h2 className="heading-lg truncate">
            {data.name ?? (loading ? "…" : "")}
          </h2>
          <span className="chip chip-accent">
            {provider === "modrinth" ? (
              <>
                <ModrinthMark size={10} /> Modrinth
              </>
            ) : (
              <>
                <CurseForgeMark size={10} /> CurseForge
              </>
            )}
          </span>
        </div>
        {data.description && (
          <p className="text-sm text-ink-secondary mt-1.5 leading-relaxed">
            {data.description}
          </p>
        )}
        <div className="text-xs text-ink-muted mt-2 flex items-center gap-3 flex-wrap">
          {data.author && <span>by {data.author}</span>}
          {typeof data.downloads === "number" && (
            <span className="inline-flex items-center gap-1">
              <Download size={11} />
              {data.downloads.toLocaleString()}
            </span>
          )}
          {typeof data.followers === "number" && data.followers > 0 && (
            <span>{data.followers.toLocaleString()} followers</span>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="btn-icon btn-ghost !h-8 !w-8 shrink-0"
      >
        <X size={14} />
      </button>
    </header>
  );
}

function DetailBody({
  data,
  loading,
  extra,
}: {
  data: Partial<ContentDetails>;
  loading: boolean;
  extra?: React.ReactNode;
}): JSX.Element {
  return (
    <div className="p-5 space-y-5">
      {/* Loader / version / category chips */}
      <div className="flex flex-wrap gap-1.5">
        {(data.loaders ?? []).slice(0, 8).map((l) => (
          <span key={`l-${l}`} className="chip chip-muted capitalize">
            {l}
          </span>
        ))}
        {(data.gameVersions ?? []).slice(0, 6).map((v) => (
          <span key={`v-${v}`} className="chip chip-muted">
            MC {v}
          </span>
        ))}
        {(data.categories ?? []).slice(0, 8).map((c) => (
          <span key={`c-${c}`} className="chip">
            {c}
          </span>
        ))}
      </div>

      {extra}

      {data.gallery && data.gallery.length > 0 && (
        <Gallery items={data.gallery} />
      )}

      {data.links && data.links.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {data.links.map((l) => (
            <a
              key={l.url}
              className="chip"
              href={l.url}
              target="_blank"
              rel="noreferrer"
            >
              {l.label} <ExternalLink size={10} />
            </a>
          ))}
        </div>
      )}

      <BodyRender body={data.body} format={data.bodyFormat} loading={loading} />
    </div>
  );
}

function Gallery({ items }: { items: GalleryItem[] }): JSX.Element {
  // Featured first, then everything else.
  const ordered = useMemo(
    () =>
      [...items].sort((a, b) =>
        Number(Boolean(b.featured)) - Number(Boolean(a.featured))
      ),
    [items]
  );
  // `dir` records which direction the next mount should slide in from
  // (+1 = entered from the right, -1 = entered from the left). Drives
  // the AnimatePresence variants below so user intent maps to motion.
  const [[idx, dir], setState] = useState<[number, number]>([0, 0]);
  const cur = ordered[idx];

  if (!cur) return <></>;
  const go = (delta: number): void =>
    setState(([i]) => [
      (i + delta + ordered.length) % ordered.length,
      delta,
    ]);
  const next = (): void => go(1);
  const prev = (): void => go(-1);

  return (
    <div className="space-y-2">
      <div className="relative rounded-lg overflow-hidden bg-surface-2 aspect-video">
        <AnimatePresence initial={false} mode="popLayout" custom={dir}>
          <motion.img
            key={idx}
            src={cur.url}
            alt={cur.title ?? ""}
            custom={dir}
            variants={slideVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{
              x: { type: "spring", stiffness: 280, damping: 32 },
              opacity: { duration: 0.18 },
            }}
            draggable={false}
            className="absolute inset-0 w-full h-full object-contain"
          />
        </AnimatePresence>
        {ordered.length > 1 && (
          <>
            <button
              onClick={prev}
              className="absolute left-2 top-1/2 -translate-y-1/2 w-8 h-8 grid place-items-center rounded-full bg-black/40 text-white hover:bg-black/60 z-10"
              aria-label="Previous"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              onClick={next}
              className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 grid place-items-center rounded-full bg-black/40 text-white hover:bg-black/60 z-10"
              aria-label="Next"
            >
              <ChevronRight size={16} />
            </button>
            <span className="absolute bottom-2 right-2 text-[10px] text-white bg-black/50 rounded-full px-2 py-0.5 tabular-nums z-10">
              {idx + 1} / {ordered.length}
            </span>
          </>
        )}
      </div>
      {(cur.title || cur.description) && (
        <div className="text-xs text-ink-muted">
          {cur.title && <span className="font-medium">{cur.title}</span>}
          {cur.description && (
            <span className="ml-2">{cur.description}</span>
          )}
        </div>
      )}
    </div>
  );
}

const slideVariants = {
  enter: (dir: number) => ({
    x: dir >= 0 ? "100%" : "-100%",
    opacity: 0,
  }),
  center: { x: 0, opacity: 1 },
  exit: (dir: number) => ({
    x: dir >= 0 ? "-100%" : "100%",
    opacity: 0,
  }),
};

function BodyRender({
  body,
  format,
  loading,
}: {
  body?: string;
  format?: "markdown" | "html";
  loading: boolean;
}): JSX.Element {
  if (loading) {
    return (
      <div className="space-y-2">
        <div className="h-4 rounded bg-surface-2 w-3/4 animate-pulse" />
        <div className="h-4 rounded bg-surface-2 w-full animate-pulse" />
        <div className="h-4 rounded bg-surface-2 w-5/6 animate-pulse" />
      </div>
    );
  }
  if (!body) {
    return (
      <p className="text-sm text-ink-muted italic">
        No description provided.
      </p>
    );
  }
  if (format === "html") {
    // CurseForge returns its own pre-sanitised HTML. We pass it through
    // a light cleaner that strips <script>, on*= handlers, and javascript:
    // hrefs as a defence-in-depth measure, and force every <a> to open
    // in a new tab.
    const safe = sanitizeHtml(body);
    return (
      <div
        className="content-body text-sm leading-relaxed"
        dangerouslySetInnerHTML={{ __html: safe }}
      />
    );
  }
  return (
    <div className="content-body text-sm leading-relaxed">
      {renderMarkdown(body)}
    </div>
  );
}

/* ============================ MARKDOWN MINI ============================ */

/**
 * Minimal block-level markdown renderer. Handles:
 *   - ATX headings (#, ##, ###)
 *   - fenced code blocks (```)
 *   - bullet and numbered lists
 *   - blockquotes (>)
 *   - paragraphs
 *   - horizontal rules
 * Inline syntax (bold, italic, code, links, images) is handled by
 * `renderInline`. Anything we don't recognise falls through as a
 * paragraph with inline parsing — good enough for Modrinth bodies, which
 * are mostly screenshots, headings, and bullet lists.
 */
function renderMarkdown(src: string): JSX.Element[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: JSX.Element[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim() === "") {
      i++;
      continue;
    }

    // Fenced code block
    const fence = line.match(/^```(\w+)?\s*$/);
    if (fence) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) {
        buf.push(lines[i]!);
        i++;
      }
      i++; // skip closing fence
      blocks.push(
        <pre
          key={key++}
          className="rounded-md bg-surface-2 border border-line p-3 text-xs overflow-x-auto"
        >
          <code>{buf.join("\n")}</code>
        </pre>
      );
      continue;
    }

    // Heading
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = heading[1]!.length;
      const text = heading[2]!;
      const cls =
        level === 1
          ? "heading-lg mt-4"
          : level === 2
            ? "heading-md mt-4"
            : "font-semibold text-ink mt-3";
      blocks.push(
        <div key={key++} className={cls}>
          {renderInline(text)}
        </div>
      );
      i++;
      continue;
    }

    // Horizontal rule
    if (/^---+\s*$/.test(line)) {
      blocks.push(
        <hr key={key++} className="border-line my-3" />
      );
      i++;
      continue;
    }

    // Bullet list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*[-*+]\s+/, ""));
        i++;
      }
      blocks.push(
        <ul key={key++} className="list-disc pl-5 space-y-1">
          {items.map((it, j) => (
            <li key={j}>{renderInline(it)}</li>
          ))}
        </ul>
      );
      continue;
    }

    // Numbered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      blocks.push(
        <ol key={key++} className="list-decimal pl-5 space-y-1">
          {items.map((it, j) => (
            <li key={j}>{renderInline(it)}</li>
          ))}
        </ol>
      );
      continue;
    }

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) {
        buf.push(lines[i]!.replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push(
        <blockquote
          key={key++}
          className="border-l-2 border-line pl-3 italic text-ink-secondary"
        >
          {renderInline(buf.join(" "))}
        </blockquote>
      );
      continue;
    }

    // Paragraph — gather consecutive non-blank lines
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !/^(#{1,4}\s|\s*[-*+]\s|\s*\d+\.\s|\s*>\s?|---+\s*$|```)/.test(lines[i]!)
    ) {
      buf.push(lines[i]!);
      i++;
    }
    blocks.push(
      <p key={key++} className="text-ink-secondary">
        {renderInline(buf.join(" "))}
      </p>
    );
  }

  return blocks;
}

/**
 * Inline markdown parser for the subset we care about: images, links,
 * inline code, bold, italic. Returns React fragments. Anything that
 * doesn't match falls through as plain text, so unparseable input is
 * always shown verbatim, never silently dropped.
 */
function renderInline(src: string): React.ReactNode {
  // Tokenise greedily by scanning for the first match of any pattern,
  // emit the preceding plain text + the matched node, then continue.
  const out: React.ReactNode[] = [];
  let s = src;
  let key = 0;

  // Pattern matching priority (image > link > inline-code > bold > italic).
  // Using anchored regexes so we can re-scan from the new offset.
  const imgRe = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/;
  const linkRe = /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/;
  const codeRe = /`([^`]+)`/;
  const boldRe = /\*\*([^*]+)\*\*/;
  const italicRe = /\*([^*]+)\*|_([^_]+)_/;

  while (s.length > 0) {
    const matches = [
      { kind: "img" as const, m: imgRe.exec(s) },
      { kind: "link" as const, m: linkRe.exec(s) },
      { kind: "code" as const, m: codeRe.exec(s) },
      { kind: "bold" as const, m: boldRe.exec(s) },
      { kind: "italic" as const, m: italicRe.exec(s) },
    ].filter((x) => x.m) as Array<{
      kind: "img" | "link" | "code" | "bold" | "italic";
      m: RegExpExecArray;
    }>;
    if (matches.length === 0) {
      out.push(s);
      break;
    }
    matches.sort((a, b) => a.m.index - b.m.index);
    const { kind, m } = matches[0]!;
    if (m.index > 0) out.push(s.slice(0, m.index));
    const after = m.index + m[0].length;
    if (kind === "img") {
      const [, alt, url] = m;
      if (isSafeUrl(url ?? "")) {
        out.push(
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={key++}
            src={url}
            alt={alt ?? ""}
            className="rounded-md max-w-full my-2"
            loading="lazy"
          />
        );
      }
    } else if (kind === "link") {
      const [, text, url] = m;
      if (isSafeUrl(url ?? "")) {
        out.push(
          <a
            key={key++}
            href={url}
            target="_blank"
            rel="noreferrer"
            className="link"
          >
            {text}
          </a>
        );
      } else {
        out.push(text);
      }
    } else if (kind === "code") {
      out.push(
        <code
          key={key++}
          className="kbd text-[11px] px-1 py-0.5"
        >
          {m[1]}
        </code>
      );
    } else if (kind === "bold") {
      out.push(
        <strong key={key++} className="text-ink">
          {m[1]}
        </strong>
      );
    } else {
      out.push(
        <em key={key++}>{m[1] ?? m[2]}</em>
      );
    }
    s = s.slice(after);
  }
  return out;
}

/* ============================== HELPERS ============================== */

function isSafeUrl(url: string): boolean {
  if (!url) return false;
  // Block obviously dangerous schemes. Allow http(s), data:image, and
  // protocol-relative // URLs. Modrinth/CurseForge always serve over
  // https so this is permissive enough for legitimate content.
  const lower = url.trim().toLowerCase();
  if (lower.startsWith("javascript:")) return false;
  if (lower.startsWith("vbscript:")) return false;
  if (lower.startsWith("data:") && !lower.startsWith("data:image/")) {
    return false;
  }
  return true;
}

/**
 * Tiny HTML cleaner for CurseForge bodies. Removes <script>, <iframe>,
 * <style>, on* event-handler attributes, and javascript: hrefs. Not a
 * full sanitiser — relies on the upstream API (CurseForge) already
 * delivering clean HTML — but ensures the panel doesn't blindly inject
 * anything too obviously hostile.
 */
function sanitizeHtml(html: string): string {
  let h = html;
  h = h.replace(/<\/?(script|iframe|style|object|embed)[^>]*>/gi, "");
  h = h.replace(/\son\w+\s*=\s*"[^"]*"/gi, "");
  h = h.replace(/\son\w+\s*=\s*'[^']*'/gi, "");
  h = h.replace(/\son\w+\s*=\s*[^\s>]+/gi, "");
  h = h.replace(/href\s*=\s*"javascript:[^"]*"/gi, 'href="#"');
  h = h.replace(/href\s*=\s*'javascript:[^']*'/gi, "href='#'");
  // Force every <a> to open in a new tab + drop opener.
  h = h.replace(/<a\b([^>]*)>/gi, (full, attrs) => {
    const cleaned = String(attrs).replace(
      /\s(target|rel)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi,
      ""
    );
    return `<a${cleaned} target="_blank" rel="noreferrer">`;
  });
  return h;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}
