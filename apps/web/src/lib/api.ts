/**
 * Thin API client. All requests go through Next.js rewrites at /api/* which
 * proxy to the panel-api. This keeps cookies same-origin (httpOnly session)
 * without needing CORS at the browser level.
 */

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public data?: unknown
  ) {
    super(message);
  }
}

async function call<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "include",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const text = await res.text();
  const data = text ? tryJson(text) : undefined;
  if (!res.ok) {
    // Build a non-empty message no matter what the server returned.
    // Empty messages are common when the upstream proxy returns a
    // 502 with no body, or HTTP/2 strips the reason phrase — without
    // this fallback the panel's error dialog renders an empty box
    // and the user has no idea what failed.
    const bodyError =
      (data as any)?.error ||
      (typeof data === "string" ? (data as string) : "");
    const reason =
      typeof (data as any)?.reason === "string"
        ? ` (${(data as any).reason})`
        : "";
    const fallback = `Request failed: HTTP ${res.status}${
      res.statusText ? " " + res.statusText : ""
    }`;
    const msg = (bodyError ? `${bodyError}${reason}` : fallback) || fallback;
    throw new ApiError(res.status, msg, data);
  }
  return data as T;
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export const api = {
  get: <T>(path: string) => call<T>("GET", path),
  post: <T>(path: string, body?: unknown) => call<T>("POST", path, body),
  put: <T>(path: string, body?: unknown) => call<T>("PUT", path, body),
  patch: <T>(path: string, body?: unknown) => call<T>("PATCH", path, body),
  del: <T>(path: string) => call<T>("DELETE", path),
};

export const fetcher = <T>(path: string) => api.get<T>(path);
