import nodemailer, { type Transporter } from "nodemailer";
import { prisma } from "../db.js";
import { decryptSecret, encryptSecret } from "../crypto.js";

/**
 * SMTP configuration stored in IntegrationSetting under `smtp.*` keys.
 * The password (and only the password) is treated as a secret — every
 * other field is plaintext encrypted with the same key for symmetry.
 *
 * The transporter is built on demand and cached. We refresh it whenever
 * the config write endpoint is hit.
 */

const KEYS = {
  enabled: "smtp.enabled",
  host: "smtp.host",
  port: "smtp.port",
  secure: "smtp.secure", // "true" / "false" — STARTTLS vs implicit TLS
  user: "smtp.user",
  password: "smtp.password",
  from: "smtp.from",
  /** Public URL of the panel — used to build reset links in email bodies. */
  panelUrl: "smtp.panelUrl",
} as const;

export type SmtpConfig = {
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  password?: string;
  from: string;
  panelUrl: string;
};

async function readOne(key: string): Promise<string | null> {
  const row = await prisma.integrationSetting.findUnique({ where: { key } });
  if (!row) return null;
  try {
    return decryptSecret(row.value);
  } catch {
    return null;
  }
}

async function writeOne(key: string, value: string): Promise<void> {
  const encrypted = encryptSecret(value);
  await prisma.integrationSetting.upsert({
    where: { key },
    create: { key, value: encrypted },
    update: { value: encrypted },
  });
}

async function deleteOne(key: string): Promise<void> {
  await prisma.integrationSetting.delete({ where: { key } }).catch(() => {});
}

export async function readSmtp(): Promise<SmtpConfig | null> {
  const [enabled, host, port, secure, user, password, from, panelUrl] =
    await Promise.all([
      readOne(KEYS.enabled),
      readOne(KEYS.host),
      readOne(KEYS.port),
      readOne(KEYS.secure),
      readOne(KEYS.user),
      readOne(KEYS.password),
      readOne(KEYS.from),
      readOne(KEYS.panelUrl),
    ]);
  if (enabled !== "true") return null;
  if (!host || !port || !from) return null;
  const portN = Number(port);
  if (!Number.isFinite(portN)) return null;
  return {
    enabled: true,
    host,
    port: portN,
    secure: secure === "true",
    user: user ?? undefined,
    password: password ?? undefined,
    from,
    panelUrl: panelUrl ?? "",
  };
}

export async function readSmtpForDisplay(): Promise<{
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  hasPassword: boolean;
  from: string;
  panelUrl: string;
}> {
  const [enabled, host, port, secure, user, password, from, panelUrl] =
    await Promise.all([
      readOne(KEYS.enabled),
      readOne(KEYS.host),
      readOne(KEYS.port),
      readOne(KEYS.secure),
      readOne(KEYS.user),
      readOne(KEYS.password),
      readOne(KEYS.from),
      readOne(KEYS.panelUrl),
    ]);
  return {
    enabled: enabled === "true",
    host: host ?? "",
    port: Number(port ?? "0") || 0,
    secure: secure === "true",
    user: user ?? "",
    hasPassword: !!password,
    from: from ?? "",
    panelUrl: panelUrl ?? "",
  };
}

type WriteInput = {
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  password?: string;
  from: string;
  panelUrl: string;
};

export async function writeSmtp(input: WriteInput): Promise<void> {
  await Promise.all([
    writeOne(KEYS.enabled, input.enabled ? "true" : "false"),
    writeOne(KEYS.host, input.host),
    writeOne(KEYS.port, String(input.port)),
    writeOne(KEYS.secure, input.secure ? "true" : "false"),
    input.user ? writeOne(KEYS.user, input.user) : deleteOne(KEYS.user),
    input.password === undefined
      ? Promise.resolve()
      : input.password
        ? writeOne(KEYS.password, input.password)
        : deleteOne(KEYS.password),
    writeOne(KEYS.from, input.from),
    writeOne(KEYS.panelUrl, input.panelUrl),
  ]);
  cachedTransporter = null;
}

export async function clearSmtp(): Promise<void> {
  await Promise.all(Object.values(KEYS).map((k) => deleteOne(k)));
  cachedTransporter = null;
}

let cachedTransporter: { transporter: Transporter; key: string } | null = null;

async function getTransporter(): Promise<{
  transporter: Transporter;
  cfg: SmtpConfig;
} | null> {
  const cfg = await readSmtp();
  if (!cfg) return null;
  const cacheKey = `${cfg.host}:${cfg.port}:${cfg.user ?? ""}:${cfg.secure}`;
  if (cachedTransporter && cachedTransporter.key === cacheKey) {
    return { transporter: cachedTransporter.transporter, cfg };
  }
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth:
      cfg.user || cfg.password
        ? { user: cfg.user ?? "", pass: cfg.password ?? "" }
        : undefined,
  });
  cachedTransporter = { transporter, key: cacheKey };
  return { transporter, cfg };
}

/** Send a plain "panel" email. Subject + body are caller-built. Returns
 *  true if SMTP is configured and the send didn't throw, false otherwise.
 *  Errors are logged via the provided logger and otherwise swallowed —
 *  most callers prefer "best-effort send" semantics so user-facing flows
 *  don't fail when the operator hasn't configured SMTP yet. */
export async function sendMail(
  to: string,
  subject: string,
  textBody: string,
  htmlBody?: string,
  log?: { warn: (obj: unknown, msg?: string) => void }
): Promise<boolean> {
  const t = await getTransporter();
  if (!t) return false;
  try {
    await t.transporter.sendMail({
      from: t.cfg.from,
      to,
      subject,
      text: textBody,
      ...(htmlBody ? { html: htmlBody } : {}),
    });
    return true;
  } catch (err) {
    log?.warn({ err }, "SMTP send failed");
    return false;
  }
}

/** Build a panel-relative reset link. `panelUrl` from SMTP config wins; if
 *  it's blank we fall back to a placeholder so the email still has a
 *  functional snippet (the user can copy the token manually). */
export async function buildResetLink(token: string): Promise<string> {
  const cfg = await readSmtp();
  const base = cfg?.panelUrl?.replace(/\/$/, "") ?? "";
  if (!base) return `[set smtp.panelUrl] /reset-password?token=${token}`;
  return `${base}/reset-password?token=${token}`;
}
