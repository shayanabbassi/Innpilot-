# syntax=docker/dockerfile:1.7
# InnPilot API: production image. Build from the repository root:
#   docker build -f apps/api/Dockerfile -t innpilot-api .
# The same image runs database migrations as a separate release step, and backups and restore drills:
#   docker run --rm -e DATABASE_ADMIN_URL=... innpilot-api node node_modules/@innpilot/db/dist/cli.js migrate
#   docker run --rm --env-file ... innpilot-api node dist/ops/cli.js <keygen|backup|schedule|restore-drill>

ARG NODE_IMAGE=node:24.19.0-alpine3.24

FROM ${NODE_IMAGE} AS build
WORKDIR /repo
RUN corepack enable
# Dependencies first, so source changes do not reinstall them.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/money/package.json packages/money/
RUN pnpm install --frozen-lockfile --filter @innpilot/api...
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/api apps/api
RUN pnpm --filter @innpilot/api... build \
 && pnpm --filter @innpilot/api deploy --legacy --prod /out

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
# PostgreSQL 16 client tools (pg_dump, pg_restore) for the backup and restore commands (dist/ops/cli.js).
RUN apk add --no-cache postgresql16-client
WORKDIR /app
# Root owns the files; the server runs as the unprivileged node user and cannot change them.
COPY --from=build /out ./
USER node
EXPOSE 4000
# Readiness (database, storage, migrations) for docker and compose; uptime checks use the same endpoint.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:4000/api/v1/health/ready || exit 1
CMD ["node", "dist/main.js"]
