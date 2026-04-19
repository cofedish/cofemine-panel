import Docker from "dockerode";
import { config } from "./config.js";

export const docker = new Docker(
  config.DOCKER_HOST_URL
    ? { host: new URL(config.DOCKER_HOST_URL).hostname, port: Number(new URL(config.DOCKER_HOST_URL).port || 2375), protocol: new URL(config.DOCKER_HOST_URL).protocol.replace(":", "") as "http" | "https" }
    : { socketPath: config.DOCKER_SOCKET }
);

export async function ensureNetwork(name: string): Promise<void> {
  const networks = await docker.listNetworks({
    filters: JSON.stringify({ name: [name] }),
  });
  if (networks.length === 0) {
    await docker.createNetwork({ Name: name, Driver: "bridge" });
  }
}
