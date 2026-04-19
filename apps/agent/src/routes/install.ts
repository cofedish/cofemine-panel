import type { FastifyInstance } from "fastify";
import { z } from "zod";
import path from "node:path";
import { promises as fs } from "node:fs";
import { request } from "undici";
import { dataDirFor, ensureDir, safeResolve } from "../paths.js";
import { docker } from "../docker.js";
import { config } from "../config.js";

const planSchema = z.object({
  provider: z.enum(["modrinth", "curseforge"]),
  kind: z.enum(["modpack", "mod", "plugin", "datapack", "resourcepack", "shader"]),
  plan: z.object({
    target: z.enum(["mods", "plugins", "datapacks", "modpack-env"]),
    files: z.array(
      z.object({ url: z.string().url(), filename: z.string().min(1) })
    ),
    env: z.record(z.string(), z.string()).optional(),
    notes: z.array(z.string()).optional(),
  }),
});

export async function installAgentRoutes(app: FastifyInstance): Promise<void> {
  app.post("/servers/:id/install", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = planSchema.parse(req.body);
    const dataDir = dataDirFor(id);
    await ensureDir(dataDir);

    if (body.plan.target === "modpack-env") {
      // Persist env vars on the container by recreating it with merged env.
      if (body.plan.env && Object.keys(body.plan.env).length > 0) {
        await updateContainerEnv(id, body.plan.env);
      }
      return reply.send({
        ok: true,
        notes:
          body.plan.notes ??
          ["Modpack env applied. Restart the server to pull it."],
      });
    }

    const targetDir = safeResolve(dataDir, body.plan.target);
    await ensureDir(targetDir);
    const downloaded: string[] = [];
    for (const file of body.plan.files) {
      const dest = path.join(targetDir, file.filename);
      await downloadTo(file.url, dest);
      downloaded.push(file.filename);
    }
    return reply.send({ ok: true, downloaded });
  });
}

async function downloadTo(url: string, dest: string): Promise<void> {
  const res = await request(url, { maxRedirections: 5 });
  if (res.statusCode >= 400) {
    throw new Error(`Download failed: ${res.statusCode} for ${url}`);
  }
  const ab = await res.body.arrayBuffer();
  await fs.writeFile(dest, Buffer.from(ab));
}

/**
 * Merge extra env vars into an existing managed container by recreating it
 * with the same spec + new env. We preserve the old container id's config
 * from docker inspect; this is crude but reliable for modpack-env scenarios.
 */
async function updateContainerEnv(
  serverId: string,
  extra: Record<string, string>
): Promise<void> {
  const containers = await docker.listContainers({
    all: true,
    filters: JSON.stringify({
      label: [`${config.AGENT_LABEL_PREFIX}.serverId=${serverId}`],
    }),
  });
  const first = containers[0];
  if (!first) throw new Error("Container not found for server");
  const container = docker.getContainer(first.Id);
  const info = await container.inspect();
  const existingEnv = info.Config.Env ?? [];
  const envMap: Record<string, string> = {};
  for (const line of existingEnv) {
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    envMap[line.slice(0, eq)] = line.slice(eq + 1);
  }
  Object.assign(envMap, extra);
  const newEnv = Object.entries(envMap).map(([k, v]) => `${k}=${v}`);

  const wasRunning = info.State.Running;
  if (wasRunning) await container.stop({ t: 20 }).catch(() => {});
  await container.remove({ force: true });
  await docker.createContainer({
    name: info.Name.replace(/^\//, ""),
    Image: info.Config.Image,
    Env: newEnv,
    ExposedPorts: info.Config.ExposedPorts,
    Labels: info.Config.Labels,
    Tty: false,
    OpenStdin: true,
    StdinOnce: false,
    HostConfig: info.HostConfig,
  });
}
