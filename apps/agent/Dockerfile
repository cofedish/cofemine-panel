FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.7.0 --activate
WORKDIR /app

FROM base AS deps
# Copy the real manifests for every workspace member. These used to be
# fabricated stubs, which worked only because the install wasn't frozen:
# a frozen install compares the lockfile against the workspace, and a
# stub with no dependencies reads as "lockfile out of date".
# `--filter @cofemine/agent` still means only the agent's own deps get
# installed — the other manifests are there for lockfile validation.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/agent/package.json apps/agent/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
# Frozen: see apps/api/Dockerfile for why.
RUN pnpm install --frozen-lockfile --filter @cofemine/agent --prod=false

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/agent apps/agent
RUN pnpm --filter @cofemine/agent run build

FROM base AS runner
ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app/apps/agent
EXPOSE 4100
CMD ["node", "dist/main.js"]
