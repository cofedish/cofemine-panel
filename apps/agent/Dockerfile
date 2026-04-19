FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.7.0 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY apps/agent/package.json apps/agent/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile=false --filter @cofemine/agent... --prod=false

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
