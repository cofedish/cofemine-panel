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

export const createServerSchema = z.object({
  name: z
    .string()
    .min(2)
    .max(48)
    .regex(/^[a-zA-Z0-9 _.-]+$/, "Invalid characters"),
  description: z.string().max(500).optional(),
  nodeId: z.string().min(1),
  type: z.enum(SERVER_TYPES),
  version: z.string().min(1).max(32),
  memoryMb: z.number().int().min(512).max(65536).default(2048),
  cpuLimit: z.number().min(0.1).max(64).optional(),
  ports: z.array(portMappingSchema).min(1).max(8),
  env: z.record(z.string(), z.string()).default({}),
  eulaAccepted: z.literal(true, {
    errorMap: () => ({ message: "You must accept the Minecraft EULA" }),
  }),
  templateId: z.string().optional(),
});
export type CreateServerInput = z.infer<typeof createServerSchema>;

export const updateServerSchema = createServerSchema
  .partial()
  .omit({ eulaAccepted: true });

export const createNodeSchema = z.object({
  name: z.string().min(2).max(48),
  host: z.string().url(),
  token: z.string().min(16).max(200),
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
  query: z.string().max(200).optional(),
  gameVersion: z.string().max(32).optional(),
  loader: z.string().max(32).optional(),
  projectType: z
    .enum(["mod", "modpack", "plugin", "datapack", "resourcepack", "shader"])
    .optional(),
  limit: z.number().int().min(1).max(50).default(20),
  offset: z.number().int().min(0).max(1000).default(0),
});

export const installModrinthSchema = z.object({
  projectId: z.string().min(1),
  versionId: z.string().min(1).optional(),
  kind: z
    .enum(["modpack", "mod", "plugin", "datapack"])
    .default("mod"),
});

export const installCurseforgeSchema = z.object({
  projectId: z.number().int().positive(),
  fileId: z.number().int().positive().optional(),
  kind: z.enum(["modpack", "mod", "plugin"]).default("mod"),
});
