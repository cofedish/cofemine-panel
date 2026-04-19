import { request } from "undici";
import { prisma } from "../db.js";

/**
 * Client for calling a node-agent from the API.
 *
 * The agent itself never authenticates against a DB — it checks the bearer
 * token sent by the API. We resolve the plaintext token from an env var,
 * because storing it encrypted per-node isn't possible when the API is the
 * one *owning* that token (there's no user-supplied key). In practice you
 * configure `AGENT_TOKEN_<nodeName>` per agent, or reuse a single
 * `AGENT_TOKEN` for the default single-node compose.
 */
function resolveAgentToken(nodeName: string): string {
  const perNode = process.env[`AGENT_TOKEN_${nodeName.toUpperCase()}`];
  return perNode ?? process.env.AGENT_TOKEN ?? "";
}

export class NodeClient {
  constructor(
    public readonly nodeId: string,
    public readonly host: string,
    public readonly token: string
  ) {}

  static async forId(nodeId: string): Promise<NodeClient> {
    const node = await prisma.node.findUnique({ where: { id: nodeId } });
    if (!node) throw Object.assign(new Error("Node not found"), { statusCode: 404 });
    return new NodeClient(node.id, node.host, resolveAgentToken(node.name));
  }

  async call<T = unknown>(
    method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.host.replace(/\/$/, "")}${path}`;
    const res = await request(url, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.body.text();
    if (res.statusCode >= 400) {
      const err = new Error(
        `Agent call ${method} ${path} failed (${res.statusCode}): ${text}`
      );
      (err as any).statusCode = res.statusCode;
      throw err;
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }
}
