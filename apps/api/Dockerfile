FROM node:20-alpine AS base
# Prisma on Alpine 3.19+ needs openssl3 explicitly; without it the query
# engine fails with "Could not parse schema engine response" at startup.
RUN apk add --no-cache openssl \
 && corepack enable && corepack prepare pnpm@9.7.0 --activate
WORKDIR /app

FROM base AS deps
# Every workspace member's manifest, not just this app's: a frozen
# install compares the lockfile against the whole workspace, so a
# missing manifest reads as "lockfile out of date" and fails the build.
# No `*` on the lockfile either — if it's absent we want a loud failure,
# not a silent fresh resolve.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/agent/package.json apps/agent/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
# Frozen: builds install exactly what the committed lockfile pins.
# Without this every rebuild re-resolved caret ranges from the registry,
# so a malicious patch release of any of ~400 transitive packages would
# reach production through the push-to-main auto-deploy with nobody in
# the loop.
RUN pnpm install --frozen-lockfile --filter @cofemine/api... --prod=false

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @cofemine/api exec prisma generate
RUN pnpm --filter @cofemine/api run build

FROM base AS runner
ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app/apps/api
COPY apps/api/docker-entrypoint.sh /usr/local/bin/cofemine-api-entrypoint
RUN chmod +x /usr/local/bin/cofemine-api-entrypoint
EXPOSE 4000
CMD ["/usr/local/bin/cofemine-api-entrypoint"]
