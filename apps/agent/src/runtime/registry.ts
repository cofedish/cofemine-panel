import type { MinecraftRuntimeProvider } from "./runtime-provider.js";
import { ItzgRuntimeProvider } from "./itzg-provider.js";

const providers = new Map<string, MinecraftRuntimeProvider>();
const itzg = new ItzgRuntimeProvider();
providers.set(itzg.key, itzg);

export function getRuntime(key = "itzg"): MinecraftRuntimeProvider {
  const p = providers.get(key);
  if (!p) throw new Error(`Unknown runtime provider: ${key}`);
  return p;
}
