# One image holds the API, the background worker and the built web app.
#   API (also serves the web app):  pnpm --filter @sm/api start
#   Worker:                         pnpm --filter @sm/worker start
# Run migrations once per release:  pnpm db:migrate

# ---- Stage 1: build the web app
FROM node:24-slim AS web
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/mobile/package.json apps/mobile/
RUN pnpm install --frozen-lockfile --filter @sm/mobile...
COPY apps/mobile apps/mobile
# No server address is baked in: the web app talks to whatever address it was loaded from.
RUN pnpm --filter @sm/mobile export:web

# ---- Stage 2: the server
FROM node:24-slim
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile --filter @sm/api... --filter @sm/worker...
COPY packages packages
COPY apps/api apps/api
COPY apps/worker apps/worker
COPY --from=web /app/apps/mobile/dist apps/mobile/dist
# The server writes here at run time: the small matching model on first use, and photos when storage is local.
RUN mkdir -p /app/.data && chown -R node:node /app/.data
ENV NODE_ENV=production PORT=4000 INLINE_WORKER=false
EXPOSE 4000
USER node
CMD ["pnpm", "--filter", "@sm/api", "start"]
