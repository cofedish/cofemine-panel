FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.7.0 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY apps/agent/package.json apps/agent/package.json
COPY packages/shared/package.json packages/shared/package.json
# Stub package.json placeholders for the other workspace members so
# pnpm doesn't bail looking for them. We don't actually need their
# code — agent only needs its own deps. The previous `--filter
# @cofemine/agent...` approach silently skipped agent's devDeps
# (typescript etc.) on newer pnpm so the build step couldn't find tsc.
RUN mkdir -p apps/api apps/web && \
    echo '{"name":"@cofemine/api","version":"0.0.0","private":true}' > apps/api/package.json && \
    echo '{"name":"@cofemine/web","version":"0.0.0","private":true}' > apps/web/package.json
RUN pnpm install --frozen-lockfile=false --filter @cofemine/agent --prod=false

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
