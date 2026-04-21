/**
 * Client-side image helpers. We resize + re-encode images in the browser
 * (via <canvas>) before uploading, so users can drop in a 4000×3000 photo
 * and we still send 64×64 or 128×128 PNG to the server.
 */

const MAX_BYTES = 8 * 1024 * 1024; // 8 MiB — reject even opening larger files

export class ImageResizeError extends Error {}

export interface ResizeOptions {
  /** Target square side in pixels. */
  size: number;
  /** Output MIME type. itzg wants PNG for server-icon.png. */
  format?: "image/png" | "image/jpeg";
  /** JPEG quality (ignored for PNG). */
  quality?: number;
  /** Crop strategy. `cover` center-crops to a square (default). */
  fit?: "cover" | "contain";
}

export async function resizeImageToDataUrl(
  file: File,
  opts: ResizeOptions
): Promise<string> {
  if (file.size > MAX_BYTES) {
    throw new ImageResizeError("Image too large (max 8 MB)");
  }
  if (!file.type.startsWith("image/")) {
    throw new ImageResizeError("Not an image file");
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const canvas = document.createElement("canvas");
    canvas.width = opts.size;
    canvas.height = opts.size;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new ImageResizeError("Canvas 2D context unavailable");
    // Background for JPEG (no alpha). PNG keeps transparency.
    if (opts.format === "image/jpeg") {
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, opts.size, opts.size);
    }
    ctx.imageSmoothingEnabled = true;
    (ctx as unknown as { imageSmoothingQuality: string }).imageSmoothingQuality =
      "high";

    if ((opts.fit ?? "cover") === "cover") {
      // Center-crop source to a square, then scale to target.
      const s = Math.min(img.width, img.height);
      const sx = (img.width - s) / 2;
      const sy = (img.height - s) / 2;
      ctx.drawImage(img, sx, sy, s, s, 0, 0, opts.size, opts.size);
    } else {
      // Fit entire image, letterboxing the remainder (rare for avatars).
      const scale = Math.min(opts.size / img.width, opts.size / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      ctx.drawImage(img, (opts.size - w) / 2, (opts.size - h) / 2, w, h);
    }
    return canvas.toDataURL(opts.format ?? "image/png", opts.quality ?? 0.92);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new ImageResizeError("Could not decode image"));
    img.src = src;
  });
}
