# syntax=docker/dockerfile:1.7
# InnPilot web app: production image (Next.js standalone server). Build from the repository root:
#   docker build -f apps/web/Dockerfile -t innpilot-web .
# In the production stack the reverse proxy sends /api to the API itself; API_INTERNAL_URL is only the fallback
# for /api requests that reach this server directly, and is fixed when the image is built.

ARG NODE_IMAGE=node:24.19.0-alpine3.24

FROM ${NODE_IMAGE} AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/money/package.json packages/money/
RUN pnpm install --frozen-lockfile --filter @innpilot/web...
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY packages/money packages/money
COPY apps/web apps/web
ARG API_INTERNAL_URL=http://api:4000
ENV API_INTERNAL_URL=${API_INTERNAL_URL} NEXT_TELEMETRY_DISABLED=1 NEXT_STANDALONE=1
RUN pnpm --filter @innpilot/web... build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/login || exit 1
CMD ["node", "apps/web/server.js"]
