# syntax=docker/dockerfile:1
# OpenUptime probe: runs one check on request, from wherever this container runs. Build from the repository root:
#   docker build -f apps/probe/Dockerfile -t openuptime-probe .
#   docker run -d -p 8787:8787 -e PROBE_SECRET=… openuptime-probe

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile --filter @openuptime/probe...
RUN pnpm --filter @openuptime/probe build:node

FROM node:22-alpine
ENV NODE_ENV=production PORT=8787
WORKDIR /app
COPY --from=build /src/apps/probe/dist/server.mjs ./server.mjs
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- "http://127.0.0.1:${PORT}/" >/dev/null || exit 1
CMD ["node", "server.mjs"]
