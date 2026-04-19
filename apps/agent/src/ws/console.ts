import type { FastifyInstance } from "fastify";
import type { WebSocket as FastifyWS } from "@fastify/websocket";
import type { Readable } from "node:stream";
import { docker } from "../docker.js";
import { config } from "../config.js";
import { execInContainer } from "../utils/exec.js";

async function findContainer(serverId: string) {
  const containers = await docker.listContainers({
    all: true,
    filters: JSON.stringify({
      label: [`${config.AGENT_LABEL_PREFIX}.serverId=${serverId}`],
    }),
  });
  if (containers.length === 0) return null;
  const first = containers[0];
  if (!first) return null;
  return docker.getContainer(first.Id);
}

export async function consoleAgentWs(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>(
    "/ws/servers/:id/console",
    { websocket: true },
    async (socket: FastifyWS, req) => {
      const { id } = req.params;
      const container = await findContainer(id);
      if (!container) {
        socket.close(4404, "no container");
        return;
      }
      const info = await container.inspect();
      const send = (msg: object): void => {
        try {
          socket.send(JSON.stringify(msg));
        } catch {}
      };
      if (!info.State.Running) {
        send({
          type: "status",
          message: "container is not running; start it to see live logs",
        });
      }

      const logs = (await container.logs({
        follow: true,
        stdout: true,
        stderr: true,
        tail: 200,
        timestamps: false,
      })) as unknown as Readable;

      logs.on("data", (chunk: Buffer) => {
        // Docker multiplexes logs when there is no TTY. Strip the 8-byte
        // header per frame; the remainder is the UTF-8 payload.
        let offset = 0;
        while (offset < chunk.length) {
          const stream = chunk[offset] === 2 ? "stderr" : "stdout";
          const size = chunk.readUInt32BE(offset + 4);
          const payload = chunk
            .slice(offset + 8, offset + 8 + size)
            .toString("utf8");
          send({ type: "log", stream, data: payload });
          offset += 8 + size;
        }
      });
      logs.on("end", () => send({ type: "status", message: "log stream ended" }));
      logs.on("error", (err) => send({ type: "error", message: String(err) }));

      socket.on("message", async (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as {
            type?: string;
            command?: string;
          };
          if (msg.type === "command" && msg.command) {
            try {
              const out = await execInContainer(container, [
                "rcon-cli",
                msg.command,
              ]);
              send({ type: "command-result", data: out });
            } catch (err) {
              send({ type: "error", message: String(err) });
            }
          }
        } catch (err) {
          send({ type: "error", message: "bad message: " + String(err) });
        }
      });

      socket.on("close", () => {
        try {
          (logs as any).destroy?.();
        } catch {}
      });
    }
  );
}
