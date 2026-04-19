import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";

const prisma = new PrismaClient();

async function main() {
  const existingUsers = await prisma.user.count();
  if (existingUsers === 0) {
    const email = process.env.BOOTSTRAP_OWNER_EMAIL;
    const username = process.env.BOOTSTRAP_OWNER_USERNAME;
    const password = process.env.BOOTSTRAP_OWNER_PASSWORD;
    if (email && username && password) {
      await prisma.user.create({
        data: {
          email,
          username,
          password: await bcrypt.hash(password, 12),
          role: "OWNER",
        },
      });
      console.log(`Seed: bootstrap owner created (${email})`);
    } else {
      console.log(
        "Seed: no users found; first-run setup available at /auth/setup"
      );
    }
  }

  // Register a local node if AGENT_TOKEN is provided and no node exists.
  const nodeCount = await prisma.node.count();
  const agentToken = process.env.AGENT_TOKEN;
  const agentHost = process.env.AGENT_PUBLIC_URL ?? "http://agent:4100";
  if (nodeCount === 0 && agentToken) {
    const tokenHash = crypto
      .createHash("sha256")
      .update(agentToken)
      .digest("hex");
    await prisma.node.create({
      data: {
        name: "local",
        host: agentHost,
        tokenHash,
      },
    });
    console.log(`Seed: local node registered at ${agentHost}`);
  }

  // Demo templates
  const tplCount = await prisma.template.count();
  if (tplCount === 0) {
    await prisma.template.createMany({
      data: [
        {
          name: "Paper Survival",
          description: "Performant Paper server for vanilla-like survival",
          type: "PAPER",
          version: "1.21.1",
          memoryMb: 4096,
          env: { DIFFICULTY: "normal", MAX_PLAYERS: "20" },
        },
        {
          name: "Fabric Modded",
          description: "Fabric with Fabric API preinstalled",
          type: "FABRIC",
          version: "1.21.1",
          memoryMb: 6144,
          env: { DIFFICULTY: "normal" },
        },
        {
          name: "Vanilla Latest",
          description: "Mojang vanilla, latest release",
          type: "VANILLA",
          version: "LATEST",
          memoryMb: 3072,
          env: {},
        },
      ],
    });
    console.log("Seed: demo templates inserted");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
