# syntax=docker/dockerfile:1

# lumina-server — self-hosted companion server for Lumina Code.
#
# Build from the REPO ROOT so the workspace lockfile installs exactly
# what CI checked:
#   docker build -f server/Dockerfile -t lumina-server .
#
# One container, one SQLite file. Put LUMINA_DATA_DIR on a volume.

FROM node:22-alpine AS deps
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY server/package.json server/
# pnpm via corepack (bundled with node:22). Filtered install: resolve
# against the workspace lockfile, fetch only lumina-server's deps.
RUN corepack enable pnpm && pnpm install --filter lumina-server --frozen-lockfile

FROM node:22-alpine AS build
WORKDIR /repo
COPY --from=deps /repo .
COPY server server
RUN corepack enable pnpm && pnpm --filter lumina-server run build

FROM node:22-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
ENV LUMINA_DATA_DIR=/data
# next standalone output carries its own minimal node_modules
COPY --from=build /repo/server/.next/standalone ./
COPY --from=build /repo/server/.next/static ./.next/static
# better-sqlite3's native binding is resolved from the standalone tree;
# keep an explicit copy of the prebuilt module as a fallback path.
COPY --from=build /repo/server/node_modules/better-sqlite3 ./node_modules/better-sqlite3
VOLUME /data
EXPOSE 3000
CMD ["node", "server.js"]
