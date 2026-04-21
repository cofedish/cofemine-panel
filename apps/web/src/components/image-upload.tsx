"use client";
import { useRef, useState } from "react";
import { Upload, Trash2, Loader2 } from "lucide-react";
import { resizeImageToDataUrl, ImageResizeError } from "@/lib/image";
import { cn } from "@/lib/cn";

/**
 * Square image uploader with live preview, client-side canvas resize,
 * and remove button. `value` is a base64 data URL (or null). `onChange`
 * fires with the new data URL after a successful upload, or null when
 * the user clicks remove.
 *
 * The resize happens entirely in the browser, so we send a tight
 * N×N PNG (or JPEG) to the server regardless of how huge the source is.
 */
export function ImageUpload({
  value,
  onChange,
  targetSize,
  format = "image/png",
  shape = "round",
  previewSize = 80,
  label = "Upload image",
  hint,
}: {
  value?: string | null;
  onChange: (next: string | null) => void;
  targetSize: number;
  format?: "image/png" | "image/jpeg";
  shape?: "round" | "square";
  previewSize?: number;
  label?: string;
  hint?: string;
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleFile(file: File): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      const dataUrl = await resizeImageToDataUrl(file, {
        size: targetSize,
        format,
        fit: "cover",
      });
      onChange(dataUrl);
    } catch (e) {
      setErr(
        e instanceof ImageResizeError
          ? e.message
          : e instanceof Error
            ? e.message
            : "Failed to process image"
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-4">
      <div
        className={cn(
          "relative overflow-hidden bg-surface-2 grid place-items-center border border-line shrink-0",
          shape === "round" ? "rounded-full" : "rounded-lg"
        )}
        style={{ width: previewSize, height: previewSize }}
      >
        {value ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={value}
            alt="preview"
            className="w-full h-full object-cover"
            draggable={false}
          />
        ) : (
          <span className="text-ink-muted text-xs text-center px-2">
            No image
          </span>
        )}
        {busy && (
          <span className="absolute inset-0 bg-black/40 grid place-items-center text-white">
            <Loader2 size={20} className="animate-spin" />
          </span>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
            e.target.value = ""; // allow re-picking the same file
          }}
        />
        <div className="flex gap-2 flex-wrap">
          <button
            type="button"
            className="btn btn-subtle"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
          >
            <Upload size={14} /> {label}
          </button>
          {value && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => onChange(null)}
              disabled={busy}
            >
              <Trash2 size={14} /> Remove
            </button>
          )}
        </div>
        <p className="text-xs text-ink-muted mt-2">
          {hint ??
            `Image will be cropped to square and resized to ${targetSize}×${targetSize}.`}
        </p>
        {err && (
          <div className="text-xs text-[rgb(var(--danger))] mt-1">{err}</div>
        )}
      </div>
    </div>
  );
}
