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
  readDownloadProxy,
  readDownloadProxyForDisplay,
  writeDownloadProxy,
} from "./download-proxy.js";
import {
  clearMavenCa,
  generateMavenCa,
  readMavenCa,
  readMavenCaCertPem,
  readMavenCaForDisplay,
} from "./maven-ca.js";
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

/**
 * Translate the current Download Proxy setting into the URL that
 * maven-cache's gost expects as UPSTREAM_PROXY, and push it to every
 * registered node's agent. Returns per-node results for the audit
 * log; never throws — a single offline node shouldn't block the save.
 *
 * URL shape: `socks5://host.docker.internal:<port>` /
 * `http://host.docker.internal:<port>`. The MC containers reach the
 * host xray via the same alias, so any "localhost"-ish address the
 * operator typed in the UI is rewritten to host.docker.internal here.
 */
export async function applyDownloadProxyToMavenCaches(
  log: { warn: (...args: unknown[]) => void; info: (...args: unknown[]) => void }
): Promise<Array<{ node: string; ok: boolean; error?: string }>> {
  const proxy = await readDownloadProxy();
  let upstreamProxy = "";
  if (proxy) {
    const host =
      proxy.host === "localhost" ||
      proxy.host === "127.0.0.1" ||
      proxy.host === "::1" ||
      proxy.host === "172.17.0.1"
        ? "host.docker.internal"
        : proxy.host;
    const scheme = proxy.protocol === "socks" ? "socks5" : "http";
    const auth =
      proxy.username || proxy.password
        ? `${encodeURIComponent(proxy.username ?? "")}:${encodeURIComponent(
            proxy.password ?? ""
          )}@`
        : "";
    upstreamProxy = `${scheme}://${auth}${host}:${proxy.port}`;
  }
  // CA material is sent on every apply so squid + every MC container
  // trust the same root. The agent treats missing CA as "MITM off,
  // run squid in pure CONNECT-passthrough mode" — fine for an
  // operator who hasn't generated one yet.
  const ca = await readMavenCa();
  const nodes = await prisma.node.findMany();
  const results: Array<{ node: string; ok: boolean; error?: string }> = [];
  for (const n of nodes) {
    try {
      const client = await NodeClient.forId(n.id);
      await client.call("POST", "/maven-cache/recreate", {
        upstreamProxy,
        caCertPem: ca?.certPem ?? null,
        caKeyPem: ca?.keyPem ?? null,
      });
      log.info({ node: n.name, upstreamProxy: upstreamProxy || "(direct)" },
        "maven-cache upstream applied");
      results.push({ node: n.name, ok: true });
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      log.warn({ node: n.name, err: msg }, "maven-cache upstream apply failed");
      results.push({ node: n.name, ok: false, error: msg });
    }
  }
  return results;
}

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
      // Push the same upstream to every node's maven-cache so the
      // cache routes through the right chain. Best-effort — we don't
      // fail the save if one node's agent is offline.
      await applyDownloadProxyToMavenCaches(req.log).catch((err) =>
        req.log.warn({ err }, "maven-cache apply failed")
      );
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
      // Push empty upstream so cache goes direct.
      await applyDownloadProxyToMavenCaches(req.log).catch((err) =>
        req.log.warn({ err }, "maven-cache apply failed")
      );
      return { ok: true };
    }
  );

  app.get("/maven-cache/status", async () => {
    const nodes = await prisma.node.findMany({ orderBy: { name: "asc" } });
    const out = await Promise.all(
      nodes.map(async (n) => {
        try {
          const client = await NodeClient.forId(n.id);
          const s = await client.call<{
            running: boolean;
            upstreamProxy: string | null;
            startedAt: string | null;
            image: string | null;
          }>("GET", "/maven-cache/status");
          return { node: n.name, ok: true, ...s };
        } catch (err: any) {
          return { node: n.name, ok: false, error: String(err?.message ?? err) };
        }
      })
    );
    return { nodes: out };
  });

  app.post(
    "/maven-cache/apply",
    { preHandler: requireGlobalPermission("integration.manage") },
    async (req) => {
      const results = await applyDownloadProxyToMavenCaches(req.log);
      await writeAudit(req, {
        action: "integration.maven-cache.apply",
        resource: "maven-cache",
        metadata: { results: results.length },
      });
      return { ok: true, results };
    }
  );

  // CA for the MITM-caching squid inside maven-cache. The cert is
  // distributed to every MC container (and to squid itself) on every
  // /maven-cache/apply, so jars cached on disk can be served decrypted.
  app.get("/maven-cache/ca", async () => {
    return readMavenCaForDisplay();
  });

  app.post(
    "/maven-cache/ca/generate",
    { preHandler: requireGlobalPermission("integration.manage") },
    async (req) => {
      const result = await generateMavenCa();
      await writeAudit(req, {
        action: "integration.maven-cache.ca.generate",
        resource: "maven-cache.ca",
        metadata: { fingerprint: result.fingerprint },
      });
      // Push the new CA to every node so any already-running MC
      // container that gets recreated picks it up next time. Existing
      // running containers still trust the old CA until restart —
      // that's fine, we don't tear them down mid-game.
      await applyDownloadProxyToMavenCaches(req.log).catch((err) =>
        req.log.warn({ err }, "maven-cache apply after CA generate failed")
      );
      return result;
    }
  );

  app.delete(
    "/maven-cache/ca",
    { preHandler: requireGlobalPermission("integration.manage") },
    async (req) => {
      await clearMavenCa();
      await writeAudit(req, {
        action: "integration.maven-cache.ca.clear",
        resource: "maven-cache.ca",
      });
      await applyDownloadProxyToMavenCaches(req.log).catch((err) =>
        req.log.warn({ err }, "maven-cache apply after CA clear failed")
      );
      return { ok: true };
    }
  );

  // Public cert download — the operator can install this in their own
  // browser / OS truststore if they want to inspect squid traffic
  // manually, but the panel auto-imports it into every MC container.
  app.get("/maven-cache/ca/cert.pem", async (_req, reply) => {
    const pem = await readMavenCaCertPem();
    if (!pem) {
      reply.code(404);
      return { error: "CA not generated yet" };
    }
    reply
      .header("content-type", "application/x-pem-file")
      .header(
        "content-disposition",
        'attachment; filename="cofemine-maven-cache-ca.pem"'
      );
    return pem;
  });

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
