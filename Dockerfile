# One image for both the API and the background worker.
#   API:    docker run ... skill-marketplace pnpm --filter @sm/api start
#   Worker: docker run ... skill-marketplace pnpm --filter @sm/worker start
# Run migrations once per release: pnpm db:migrate
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
ENV NODE_ENV=production PORT=4000 INLINE_WORKER=false
EXPOSE 4000
USER node
CMD ["pnpm", "--filter", "@sm/api", "start"]
