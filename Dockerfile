# syntax=docker/dockerfile:1.7
# Multi-stage: the toolchain (TypeScript, Vite, test deps) builds the client
# and never reaches the final image; that one holds Node, the production
# dependencies, the server sources and the built client.
# Node 24 strips the server's TypeScript types itself (erasableSyntaxOnly),
# so the server needs no compile step: what runs is what was type-checked.
ARG NODE_IMAGE=node:24-alpine

# --- 1. all dependencies, cached until a manifest changes --------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY client/package.json client/
COPY server/package.json server/
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts --no-audit --no-fund

# --- 2. build the client ---------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY shared/ shared/
COPY client/ client/
RUN npm run build --workspace client

# --- 3. production dependencies only (ws, zod, pino) -----------------------------
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY client/package.json client/
COPY server/package.json server/
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# --- 4. runtime --------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
# npm, npx, corepack and yarn are not needed to run `node`: ~20 MB less to ship and scan.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-* \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    LOG_DIR=/app/server/logs
# Least-changing layers first: dependencies, then shared code, then the server
# and the client build, so a server-only change reuses everything above it.
COPY --from=prod-deps --chown=node:node /app/node_modules node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node shared/package.json shared/
COPY --chown=node:node shared/*.ts shared/
COPY --chown=node:node shared/codec shared/codec
COPY --chown=node:node shared/net shared/net
COPY --chown=node:node shared/sim shared/sim
COPY --chown=node:node server/package.json server/
COPY --chown=node:node server/src server/src
COPY --from=build --chown=node:node /app/client/dist client/dist
RUN mkdir -p server/logs && chown node:node server/logs

# The version stamp, from the git tag in CI (shown on /health and /metrics).
ARG APP_VERSION=dev
ARG GIT_SHA=unknown
ENV APP_VERSION=${APP_VERSION} \
    GIT_SHA=${GIT_SHA}

USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
STOPSIGNAL SIGTERM
# Exec form: node is PID 1 and receives SIGTERM itself. `CMD npm start` would
# put npm (or /bin/sh) in between, the signal would not reach the server,
# and after the grace period the platform would SIGKILL a running match.
CMD ["node", "server/src/index.ts"]
