import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  installCurseforgeSchema,
  installModrinthSchema,
  modrinthSearchSchema,
} from "@cofemine/shared";
import { prisma } from "../db.js";
import { encryptSecret } from "../crypto.js";
import {
  assertServerPermission,
  requireGlobalPermission,
} from "../auth/rbac.js";
import { writeAudit } from "../audit/service.js";
import { NodeClient } from "../nodes/node-client.js";
import { ModrinthProvider } from "./modrinth-provider.js";
import { CurseForgeProvider } from "./curseforge-provider.js";
import type { ContentProvider } from "./content-provider.js";
import {
  clearDownloadProxy,
  readDownloadProxyForDisplay,
  writeDownloadProxy,
} from "./download-proxy.js";
import {
  clearSmtp,
  readSmtpForDisplay,
  sendMail,
  writeSmtp,
} from "../mail/smtp.js";

const modrinth = new ModrinthProvider();
const curseforge = new CurseForgeProvider();
const providers: Record<string, ContentProvider> = {
  modrinth,
  curseforge,
};

const settingPatchSchema = z.object({
  value: z.string().max(1000),
});

export async function integrationsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async () => {
    const [modrinthOn, curseforgeOn, rows] = await Promise.all([
      modrinth.isEnabled(),
      curseforge.isEnabled(),
      prisma.integrationSetting.findMany({
        select: { key: true, updatedAt: true },
      }),
    ]);
    return {
      providers: {
        modrinth: { enabled: modrinthOn, requiresKey: false },
        curseforge: {
          enabled: curseforgeOn,
          requiresKey: true,
          fallback: "manual-upload",
        },
      },
      settings: rows,
    };
  });

  app.patch(
    "/:key",
    { preHandler: requireGlobalPermission("integration.manage") },
    async (req) => {
      const { key } = req.params as { key: string };
      const body = settingPatchSchema.parse(req.body);
      const encrypted = encryptSecret(body.value);
      await prisma.integrationSetting.upsert({
        where: { key },
        create: { key, value: encrypted },
        update: { value: encrypted },
      });
      await writeAudit(req, {
        action: "integration.update",
        resource: key,
      });
      return { ok: true };
    }
  );

  app.delete(
    "/:key",
    { preHandler: requireGlobalPermission("integration.manage") },
    async (req) => {
      const { key } = req.params as { key: string };
      await prisma.integrationSetting.delete({ where: { key } }).catch(() => {});
      await writeAudit(req, { action: "integration.delete", resource: key });
      return { ok: true };
    }
  );

  // Modrinth
  app.get("/modrinth/search", async (req) => {
    const filters = modrinthSearchSchema.parse(req.query);
    return modrinth.search(filters);
  });

  app.get("/modrinth/projects/:id", async (req) => {
    const { id } = req.params as { id: string };
    return modrinth.getProject(id);
  });

  app.get("/modrinth/projects/:id/details", async (req) => {
    const { id } = req.params as { id: string };
    return modrinth.getDetails(id);
  });

  app.get("/modrinth/projects/:id/versions", async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { gameVersion?: string; loader?: string };
    return modrinth.getVersions(id, q);
  });

  // CurseForge
  app.get("/curseforge/search", async (req) => {
    if (!(await curseforge.isEnabled())) {
      return { disabled: true, results: [] };
    }
    const filters = modrinthSearchSchema.parse(req.query);
    return { disabled: false, results: await curseforge.search(filters) };
  });

  app.get("/curseforge/projects/:id/details", async (req) => {
    const { id } = req.params as { id: string };
    if (!(await curseforge.isEnabled())) {
      const err = new Error(
        "CurseForge API key is not set. Configure it in Integrations."
      );
      (err as any).statusCode = 409;
      throw err;
    }
    return curseforge.getDetails(Number(id));
  });

  app.get("/curseforge/projects/:id/versions", async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { gameVersion?: string; loader?: string };
    return curseforge.getVersions(Number(id), q);
  });

  // Install: routed through provider, then delegated to the node-agent.
  app.post("/servers/:id/install/modrinth", async (req) => {
    const { id } = req.params as { id: string };
    await assertServerPermission(req, id, "server.edit");
    const body = installModrinthSchema.parse(req.body);
    const server = await prisma.server.findUniqueOrThrow({ where: { id } });
    // Pre-filter by gameVersion / loader so "latest" actually means
    // "latest compatible with the target server" and not "latest
    // build of the project at all", which is what was installing
    // dynmap-for-1.21.11 on a 1.20.1 modpack.
    const versions = await modrinth.getVersions(body.projectId, {
      gameVersion: body.gameVersion,
      loader: body.loader,
    });
    const version =
      versions.find((v) => v.id === body.versionId) ?? versions[0];
    if (!version) {
      const filterDesc =
        body.gameVersion || body.loader
          ? ` matching MC ${body.gameVersion ?? "*"} / ${
              body.loader ?? "*"
            }`
          : "";
      throw new Error(
        `No compatible Modrinth version found${filterDesc}.`
      );
    }
    const plan = await modrinth.planInstall(version, body.kind);
    const client = await NodeClient.forId(server.nodeId);
    const res = await client.call("POST", `/servers/${id}/install`, {
      provider: "modrinth",
      kind: body.kind,
      plan,
    });
    await writeAudit(req, {
      action: "content.install",
      resource: id,
      metadata: { provider: "modrinth", projectId: body.projectId, kind: body.kind },
    });
    return { ok: true, result: res };
  });

  app.post("/servers/:id/install/curseforge", async (req) => {
    const { id } = req.params as { id: string };
    await assertServerPermission(req, id, "server.edit");
    const body = installCurseforgeSchema.parse(req.body);
    if (!(await curseforge.isEnabled())) {
      const err = new Error(
        "CurseForge API key is not set. Configure it in Integrations or use manual ZIP upload."
      );
      (err as any).statusCode = 409;
      throw err;
    }
    const server = await prisma.server.findUniqueOrThrow({ where: { id } });
    const versions = await curseforge.getVersions(body.projectId, {
      gameVersion: body.gameVersion,
      loader: body.loader,
    });
    const version =
      versions.find((v) => v.id === String(body.fileId)) ?? versions[0];
    if (!version) {
      const filterDesc =
        body.gameVersion || body.loader
          ? ` matching MC ${body.gameVersion ?? "*"} / ${
              body.loader ?? "*"
            }`
          : "";
      throw new Error(
        `No compatible CurseForge file found${filterDesc}.`
      );
    }
    const plan = await curseforge.planInstall(version, body.kind);
    const client = await NodeClient.forId(server.nodeId);
    const res = await client.call("POST", `/servers/${id}/install`, {
      provider: "curseforge",
      kind: body.kind,
      plan,
    });
    await writeAudit(req, {
      action: "content.install",
      resource: id,
      metadata: { provider: "curseforge", projectId: body.projectId, kind: body.kind },
    });
    return { ok: true, result: res };
  });

  // Download proxy — optional SOCKS/HTTP proxy injected into the JVM of
  // mod-install containers that are explicitly opted-in (per-server flag
  // flipped by the UI). Settings live under `download.proxy.*` keys in
  // IntegrationSetting; password is encrypted via SECRETS_KEY.
  app.get("/download-proxy", async () => {
    return readDownloadProxyForDisplay();
  });

  const writeProxySchema = z.object({
    enabled: z.boolean().default(false),
    protocol: z.enum(["socks", "http"]).default("socks"),
    host: z.string().min(1).max(255),
    port: z.coerce.number().int().min(1).max(65535),
    username: z.string().max(255).optional(),
    /** undefined = keep existing, "" = clear, otherwise overwrite. */
    password: z.string().max(512).optional(),
  });

  app.put(
    "/download-proxy",
    { preHandler: requireGlobalPermission("integration.manage") },
    async (req) => {
      const body = writeProxySchema.parse(req.body);
      await writeDownloadProxy(body);
      await writeAudit(req, {
        action: "integration.download-proxy.update",
        resource: "download.proxy",
        metadata: { enabled: body.enabled, host: body.host, port: body.port },
      });
      return { ok: true };
    }
  );

  app.delete(
    "/download-proxy",
    { preHandler: requireGlobalPermission("integration.manage") },
    async (req) => {
      await clearDownloadProxy();
      await writeAudit(req, {
        action: "integration.download-proxy.clear",
        resource: "download.proxy",
      });
      return { ok: true };
    }
  );

  // SMTP — outgoing email server used by the password-reset flow and
  // future invite/notification flows. Stored encrypted; password is
  // never returned, only `hasPassword: true` so the UI can hide the
  // field behind the same "stored" placeholder we use elsewhere.
  app.get("/smtp", async () => {
    return readSmtpForDisplay();
  });

  const writeSmtpSchema = z.object({
    enabled: z.boolean().default(false),
    host: z.string().min(1).max(255),
    port: z.coerce.number().int().min(1).max(65535),
    secure: z.boolean().default(false),
    user: z.string().max(255).optional(),
    /** undefined keeps existing, "" clears, otherwise overwrite. */
    password: z.string().max(512).optional(),
    from: z.string().min(3).max(255),
    panelUrl: z.string().url().max(255),
  });

  app.put(
    "/smtp",
    { preHandler: requireGlobalPermission("integration.manage") },
    async (req) => {
      const body = writeSmtpSchema.parse(req.body);
      await writeSmtp(body);
      await writeAudit(req, {
        action: "integration.smtp.update",
        resource: "smtp",
        metadata: {
          enabled: body.enabled,
          host: body.host,
          port: body.port,
        },
      });
      return { ok: true };
    }
  );

  app.delete(
    "/smtp",
    { preHandler: requireGlobalPermission("integration.manage") },
    async (req) => {
      await clearSmtp();
      await writeAudit(req, {
        action: "integration.smtp.clear",
        resource: "smtp",
      });
      return { ok: true };
    }
  );

  // Send a probe email to verify the configured SMTP works without
  // requiring the user to trigger a real password reset.
  app.post(
    "/smtp/test",
    { preHandler: requireGlobalPermission("integration.manage") },
    async (req, reply) => {
      const body = z
        .object({ to: z.string().email().max(255) })
        .parse(req.body);
      const sent = await sendMail(
        body.to,
        "Cofemine Panel — SMTP test",
        "This is a test email confirming your panel's SMTP settings work.",
        "<p>This is a test email confirming your panel's SMTP settings work.</p>",
        req.log
      );
      if (!sent) {
        return reply.code(409).send({
          error:
            "SMTP send failed. Check host/port/auth/from in the panel logs and try again.",
        });
      }
      return { ok: true };
    }
  );

  // unused reference to silence tsc about `providers` if needed later
  void providers;
}
