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

  // Preload the next + previous images in the carousel. Without this
  // every prev/next click visibly shows the new image loading from
  // network — the slide animation looks janky because the <img>
  // mounts mid-transition with no decoded data. Browsers de-dupe
  // these requests with the actual <img> render, so it's free.
  useEffect(() => {
    const around = [
      ordered[(idx + 1) % ordered.length],
      ordered[(idx - 1 + ordered.length) % ordered.length],
      ordered[(idx + 2) % ordered.length],
    ].filter((v): v is GalleryItem => Boolean(v));
    for (const it of around) {
      const img = new Image();
      img.src = it.url;
    }
  }, [idx, ordered]);

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
  // Both Modrinth (markdown, but CommonMark allows raw HTML) and
  // CurseForge (HTML) end up as an HTML string, then through the same
  // sanitiser, then dangerouslySetInnerHTML. The unified path is what
  // makes mods like Geckolib / Jade — whose Modrinth bodies are mostly
  // <center> / <img> / <h1 style=...> raw HTML — render correctly
  // instead of showing the literal markup as text.
  const raw = format === "html" ? body : markdownToHtml(body);
  const safe = sanitizeHtml(raw);
  return (
    <div
      className="content-body text-sm leading-relaxed"
      dangerouslySetInnerHTML={{ __html: safe }}
    />
  );
}

/* ============================ MARKDOWN MINI ============================ */

/**
 * Minimal markdown → HTML string converter. Handles:
 *   - ATX headings (#, ##, ###, ####)
 *   - fenced code blocks (```)
 *   - bullet and numbered lists
 *   - blockquotes (>)
 *   - horizontal rules
 *   - paragraphs (with inline images, links, code, bold, italic)
 *   - raw HTML blocks (CommonMark explicitly allows them — Modrinth
 *     bodies in the wild lean on this heavily, e.g. <center><img/>)
 * Output is plain HTML and is then run through `sanitizeHtml`, so any
 * unsafe markup that slips through the markdown layer still gets
 * scrubbed (script tags, on* handlers, javascript: hrefs).
 */
function markdownToHtml(src: string): string {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Fenced code block — content is escaped so it shows verbatim
    // instead of being interpreted as HTML.
    const fence = line.match(/^```(\w+)?\s*$/);
    if (fence) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) {
        buf.push(lines[i]!);
        i++;
      }
      i++; // skip closing fence
      out.push(`<pre><code>${escapeHtml(buf.join("\n"))}</code></pre>`);
      continue;
    }

    // Heading
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = heading[1]!.length;
      out.push(`<h${level}>${inlineToHtml(heading[2]!)}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^---+\s*$/.test(line)) {
      out.push("<hr>");
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
      out.push(
        `<ul>${items.map((t) => `<li>${inlineToHtml(t)}</li>`).join("")}</ul>`
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
      out.push(
        `<ol>${items.map((t) => `<li>${inlineToHtml(t)}</li>`).join("")}</ol>`
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
      out.push(`<blockquote>${inlineToHtml(buf.join(" "))}</blockquote>`);
      continue;
    }

    // Raw HTML block — line starts with `<` followed by a tag name (or
    // a closing tag). Collect consecutive non-blank lines as the block
    // and pass the markup through verbatim. Without this, Modrinth
    // descriptions that lean on <center>, <img>, <h1 style=…> show up
    // as literal source text.
    if (/^\s*<\/?\w/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && lines[i]!.trim() !== "") {
        buf.push(lines[i]!);
        i++;
      }
      out.push(buf.join("\n"));
      continue;
    }

    // Paragraph — gather consecutive non-blank lines
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !/^(#{1,4}\s|\s*[-*+]\s|\s*\d+\.\s|\s*>\s?|---+\s*$|```|\s*<\/?\w)/.test(
        lines[i]!
      )
    ) {
      buf.push(lines[i]!);
      i++;
    }
    out.push(`<p>${inlineToHtml(buf.join(" "))}</p>`);
  }

  return out.join("\n");
}

/**
 * Inline markdown → HTML. Handles images, links, inline code, bold,
 * italic. Recognised matches are emitted as HTML; everything else
 * passes through as plain text (and gets escaped). Greedy first-match
 * ordering: image > link > code > bold > italic.
 */
function inlineToHtml(src: string): string {
  let s = src;
  let out = "";

  const imgRe = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/;
  const linkRe = /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/;
  const codeRe = /`([^`]+)`/;
  const boldRe = /\*\*([^*]+)\*\*/;
  const italicRe = /\*([^*]+)\*|_([^_]+)_/;

  while (s.length > 0) {
    const candidates = [
      { kind: "img" as const, m: imgRe.exec(s) },
      { kind: "link" as const, m: linkRe.exec(s) },
      { kind: "code" as const, m: codeRe.exec(s) },
      { kind: "bold" as const, m: boldRe.exec(s) },
      { kind: "italic" as const, m: italicRe.exec(s) },
    ].filter((x): x is { kind: typeof x.kind; m: RegExpExecArray } =>
      x.m !== null
    );
    if (candidates.length === 0) {
      // No more markdown — pass through. We DON'T escape here because
      // raw HTML inside a paragraph (e.g. `<a href="x">y</a>` mixed
      // with prose) is allowed by CommonMark and the sanitiser handles
      // safety. Escaping would break valid links.
      out += s;
      break;
    }
    candidates.sort((a, b) => a.m.index - b.m.index);
    const { kind, m } = candidates[0]!;
    if (m.index > 0) out += s.slice(0, m.index);
    const after = m.index + m[0].length;

    if (kind === "img") {
      const [, alt, url] = m;
      if (isSafeUrl(url ?? "")) {
        out += `<img src="${escapeAttr(url!)}" alt="${escapeAttr(
          alt ?? ""
        )}" loading="lazy"/>`;
      }
    } else if (kind === "link") {
      const [, text, url] = m;
      if (isSafeUrl(url ?? "")) {
        out += `<a href="${escapeAttr(url!)}">${escapeHtml(text!)}</a>`;
      } else {
        out += escapeHtml(text!);
      }
    } else if (kind === "code") {
      out += `<code>${escapeHtml(m[1]!)}</code>`;
    } else if (kind === "bold") {
      out += `<strong>${escapeHtml(m[1]!)}</strong>`;
    } else {
      out += `<em>${escapeHtml(m[1] ?? m[2]!)}</em>`;
    }
    s = s.slice(after);
  }
  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
 * Tiny HTML cleaner for content bodies. Removes <script>, <iframe>,
 * <style>, on* event-handler attributes, javascript: hrefs, and ALL
 * inline `style` attributes — mod authors love things like
 * `<h1 style="font-size:10vw">` that blow up to fill the modal, and
 * inline styles are also a common XSS / overlay vector. The panel's
 * own .content-body CSS handles the real styling.
 *
 * Width/height attributes on <img> are stripped too so the CSS can
 * cap them at 100%; otherwise huge banners overflow the dialog.
 *
 * Not a full sanitiser — relies on the upstream API already delivering
 * mostly-clean HTML — but enough to keep the panel safe and laid out.
 */
function sanitizeHtml(html: string): string {
  let h = html;
  h = h.replace(/<\/?(script|iframe|style|object|embed)[^>]*>/gi, "");
  h = h.replace(/\son\w+\s*=\s*"[^"]*"/gi, "");
  h = h.replace(/\son\w+\s*=\s*'[^']*'/gi, "");
  h = h.replace(/\son\w+\s*=\s*[^\s>]+/gi, "");
  // Strip inline style + width/height attrs (quoted and unquoted forms).
  h = h.replace(/\sstyle\s*=\s*"[^"]*"/gi, "");
  h = h.replace(/\sstyle\s*=\s*'[^']*'/gi, "");
  h = h.replace(/\sstyle\s*=\s*[^\s>]+/gi, "");
  h = h.replace(/\s(width|height)\s*=\s*"[^"]*"/gi, "");
  h = h.replace(/\s(width|height)\s*=\s*'[^']*'/gi, "");
  h = h.replace(/\s(width|height)\s*=\s*[^\s>]+/gi, "");
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
