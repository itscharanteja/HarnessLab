FROM node:22.23.4-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS workspace
WORKDIR /workspace
ENV COREPACK_HOME=/opt/corepack
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY apps/ apps/
COPY packages/ packages/

FROM workspace AS web-build
RUN pnpm --filter @harnesslab/web... install --frozen-lockfile
RUN pnpm --filter @harnesslab/web build

FROM web-build AS web
ENV NODE_ENV=production
CMD ["pnpm", "--filter", "@harnesslab/web", "start", "--hostname", "0.0.0.0"]

FROM workspace AS api
RUN pnpm --filter @harnesslab/api... install --frozen-lockfile --prod
USER node
CMD ["node", "apps/api/src/server.ts"]

FROM workspace AS dispatcher
RUN pnpm --filter @harnesslab/dispatcher... install --frozen-lockfile --prod
USER node
CMD ["node", "apps/dispatcher/src/server.ts"]
