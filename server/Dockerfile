# syntax=docker/dockerfile:1

# lumina-code-server — self-hosted companion server for Lumina Code.
#
# Build from the REPO ROOT so the workspace lockfile installs exactly
# what CI checked:
#   docker build -f server/Dockerfile -t lumina-code-server .
#
# One container, one SQLite file. Put LUMINA_DATA_DIR on a volume.

FROM node:22-alpine AS deps
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY server/package.json server/
# pnpm via corepack (bundled with node:22). Filtered install: resolve
# against the workspace lockfile, fetch only lumina-code-server's deps.
RUN corepack enable pnpm && pnpm install --filter lumina-code-server --frozen-lockfile

FROM node:22-alpine AS build
WORKDIR /repo
COPY --from=deps /repo .
COPY server server
RUN corepack enable pnpm && pnpm --filter lumina-code-server run build

FROM node:22-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
ENV LUMINA_DATA_DIR=/data
# pnpm-workspace nesting (live-verified): with the lockfile at the repo
# root, Next's standalone output is MONOREPO-SHAPED — the entry sits at
# .next/standalone/server/server.js with the shared node_modules (and
# the app's own next) beside it, NOT server.js at the top. Everything
# downstream follows that shape:
#   • CMD targets server/server.js
#   • .next/static belongs to server/.next/static (next to the entry)
#   • server/node_modules/better-sqlite3 is a pnpm SYMLINK whose target
#     lives in the root store without a top-level link — COPY resolves
#     it into a real /app/node_modules/better-sqlite3, which is the
#     position Node's resolver finds from server/ (verified by booting
#     the tree: register/login exercise both native modules).
COPY --from=build /repo/server/.next/standalone ./
COPY --from=build /repo/server/.next/static ./server/.next/static
COPY --from=build /repo/server/node_modules/better-sqlite3 ./node_modules/better-sqlite3
VOLUME /data
EXPOSE 3000
CMD ["node", "server/server.js"]
