import { z } from "zod";
import { SERVER_TYPES } from "./server-types";
import { ROLES } from "./roles";

export const emailSchema = z.string().email().max(255);
export const usernameSchema = z
  .string()
  .min(2)
  .max(32)
  .regex(/^[a-zA-Z0-9_.-]+$/, "Only letters, digits, _, ., - allowed");
export const passwordSchema = z.string().min(8).max(200);

export const setupSchema = z.object({
  email: emailSchema,
  username: usernameSchema,
  password: passwordSchema,
});

export const loginSchema = z.object({
  usernameOrEmail: z.string().min(2).max(255),
  password: passwordSchema,
});

export const portMappingSchema = z.object({
  host: z.number().int().min(1).max(65535),
  container: z.number().int().min(1).max(65535),
  protocol: z.enum(["tcp", "udp"]).default("tcp"),
});

const createServerShape = z.object({
  // Human-readable name. We allow Unicode letters/digits (so Cyrillic +
  // accented names work) plus common punctuation that shows up in modpack
  // titles — colon, apostrophe, parentheses, ampersand, etc. The Docker
  // container name is derived separately via toContainerName() which
  // strips this down to an ASCII slug, so shell/container safety isn't
  // coupled to what the user types here.
  name: z
    .string()
    .min(2)
    .max(80)
    .regex(
      /^[\p{L}\p{N} _.,'"()&!?:;+\-]+$/u,
      "Invalid characters"
    ),
  description: z.string().max(500).optional(),
  nodeId: z.string().min(1),
  type: z.enum(SERVER_TYPES),
  /**
   * MC version. Required for regular types; optional for modpack sources
   * (MODRINTH / CURSEFORGE) where the runtime detects it from the pack.
   */
  version: z.string().max(32).optional().default("LATEST"),
  memoryMb: z.number().int().min(512).max(65536).default(2048),
  cpuLimit: z.number().min(0.1).max(64).optional(),
  ports: z.array(portMappingSchema).min(1).max(8),
  env: z.record(z.string(), z.string()).default({}),
  eulaAccepted: z.literal(true, {
    errorMap: () => ({ message: "You must accept the Minecraft EULA" }),
  }),
  templateId: z.string().optional(),
  /** Modpack pick-up (only meaningful when type is MODRINTH or CURSEFORGE) */
  modpack: z
    .object({
      provider: z.enum(["modrinth", "curseforge"]),
      projectId: z.string().min(1).max(128),
      url: z.string().url().optional(),
      slug: z.string().max(128).optional(),
      /** Pin a specific pack version instead of "latest". For Modrinth
       *  this is a version id; for CurseForge it's the numeric file id
       *  (passed as a string so we don't have to juggle Number/BigInt).
       *  Absent = let itzg pick the newest published version (old behavior). */
      versionId: z.string().min(1).max(128).optional(),
      /** Human label for the pinned version ("1.5.3", "v2.0.1") — UI-only,
       *  ignored by the runtime. Purely for display in the Overview. */
      versionLabel: z.string().max(128).optional(),
    })
    .optional(),
});

export const createServerSchema = createServerShape.refine(
  (v) => {
    if (v.type === "MODRINTH" || v.type === "CURSEFORGE") {
      return v.modpack != null;
    }
    return !!v.version && v.version.length > 0;
  },
  {
    message:
      "version is required for plain server types; modpack is required for MODRINTH/CURSEFORGE",
    path: ["version"],
  }
);
export type CreateServerInput = z.infer<typeof createServerSchema>;

export const updateServerSchema = createServerShape
  .partial()
  .omit({ eulaAccepted: true });

export const createNodeSchema = z.object({
  name: z.string().min(2).max(48),
  host: z.string().url(),
  token: z.string().min(16).max(200),
});

export const updateNodeSchema = z.object({
  name: z.string().min(2).max(48).optional(),
});

export const createTemplateSchema = z.object({
  name: z.string().min(2).max(64),
  description: z.string().max(500).optional(),
  type: z.enum(SERVER_TYPES),
  version: z.string().min(1).max(32),
  memoryMb: z.number().int().min(512).max(65536),
  env: z.record(z.string(), z.string()).default({}),
});

export const consoleCommandSchema = z.object({
  command: z.string().min(1).max(1000),
});

export const filePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((p) => !p.includes(".."), "Path traversal not allowed")
  .refine((p) => !p.startsWith("/"), "Use relative paths");

export const writeFileSchema = z.object({
  path: filePathSchema,
  content: z.string().max(5 * 1024 * 1024), // 5 MiB cap for text edits
});

export const scheduleSchema = z.object({
  name: z.string().min(1).max(64),
  cron: z.string().min(5).max(128),
  action: z.enum(["restart", "backup", "command", "announce"]),
  payload: z.record(z.string(), z.any()).optional(),
  enabled: z.boolean().default(true),
});

export const createUserSchema = z.object({
  email: emailSchema,
  username: usernameSchema,
  password: passwordSchema,
  role: z.enum(ROLES).default("VIEWER"),
});

export const updateUserSchema = z.object({
  email: emailSchema.optional(),
  username: usernameSchema.optional(),
  password: passwordSchema.optional(),
  role: z.enum(ROLES).optional(),
});

export const modrinthSearchSchema = z.object({
  // Treat empty string as absent so an empty query doesn't trip validation.
  query: z
    .string()
    .max(200)
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined)),
  gameVersion: z
    .string()
    .max(32)
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined)),
  loader: z
    .string()
    .max(32)
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined)),
  projectType: z
    .enum(["mod", "modpack", "plugin", "datapack", "resourcepack", "shader"])
    .optional(),
  // Query params arrive as strings — coerce so '20' parses as 20.
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).max(1000).default(0),
});

export const installModrinthSchema = z.object({
  projectId: z.string().min(1),
  versionId: z.string().min(1).optional(),
  kind: z
    .enum(["modpack", "mod", "plugin", "datapack"])
    .default("mod"),
  // Optional filters used to resolve "latest compatible" version when
  // versionId isn't pinned. Crucial for plugin-on-modpack installs
  // (e.g. dynmap onto a 1.20.1-Forge pack) — without them, Modrinth
  // returns its newest build which usually targets the newest MC and
  // is incompatible with older modpacks.
  gameVersion: z.string().min(1).optional(),
  loader: z.string().min(1).optional(),
});

export const installCurseforgeSchema = z.object({
  projectId: z.number().int().positive(),
  fileId: z.number().int().positive().optional(),
  kind: z.enum(["modpack", "mod", "plugin"]).default("mod"),
  gameVersion: z.string().min(1).optional(),
  loader: z.string().min(1).optional(),
});
