FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.7.0 --activate
WORKDIR /app

FROM base AS deps
# All workspace manifests + the lockfile: a frozen install validates
# against the whole workspace. See apps/api/Dockerfile.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/docker-shim/package.json apps/docker-shim/package.json
COPY apps/agent/package.json apps/agent/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile --filter @cofemine/docker-shim --prod=false

FROM deps AS build
COPY tsconfig.base.json ./
COPY apps/docker-shim apps/docker-shim
RUN pnpm --filter @cofemine/docker-shim run build

FROM base AS runner
ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app/apps/docker-shim
EXPOSE 4200
# Compiled output, like the agent: this service has no dependency on
# @cofemine/shared, so there is no raw-TS import to keep tsx around for.
CMD ["node", "dist/main.js"]
