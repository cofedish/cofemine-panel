import Docker from "dockerode";
import { config } from "./config.js";

/**
 * The only dockerode instance in the entire stack, in the only service
 * that mounts `/var/run/docker.sock`.
 *
 * Nothing here should be exported beyond this package. The agent — which
 * carries the file manager, the archive extractor, the content
 * downloader and every other route that has historically had bugs —
 * reaches Docker only through this service's HTTP API and has no socket
 * of its own.
 */
export const docker = new Docker(
  config.DOCKER_HOST_URL
    ? {
        host: new URL(config.DOCKER_HOST_URL).hostname,
        port: Number(new URL(config.DOCKER_HOST_URL).port || 2375),
        protocol: new URL(config.DOCKER_HOST_URL).protocol.replace(
          ":",
          ""
        ) as "http" | "https",
      }
    : { socketPath: config.DOCKER_SOCKET }
);

export function badRequest(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 });
}

export function notFound(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 404 });
}
