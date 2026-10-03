# syntax=docker/dockerfile:1.7
# Build context = repo root:  docker build -f infra/docker/Dockerfile --target <app|media-worker|web> .
ARG NODE_VERSION=24

# ---- deps: cache pnpm store from lockfile only (re-runs only when pnpm-lock.yaml changes)
FROM node:${NODE_VERSION}-bookworm-slim AS deps
ENV PNPM_HOME=/pnpm CI=true
ENV PATH=$PNPM_HOME:$PATH
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/* && corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store corepack pnpm fetch

# ---- build: install offline, copy sources, generate Prisma client
FROM deps AS build
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    corepack pnpm install --offline --frozen-lockfile \
    && corepack pnpm --filter @lyonix/db prisma:generate

# ---- app: api + workflow/audio workers (packages export TS sources, so runtime uses tsx like dev)
FROM build AS app
ENV NODE_ENV=production MEDIA_ROOT=./data/media
RUN mkdir -p /app/data/media
EXPOSE 3000
CMD ["corepack", "pnpm", "--filter", "@lyonix/api", "exec", "tsx", "src/main.ts"]

# ---- media-worker: the ONLY image that contains FFmpeg
FROM app AS media-worker
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
CMD ["corepack", "pnpm", "--filter", "@lyonix/media-worker", "start"]

# ---- web: static SPA, API origin baked at build time
FROM build AS web-build
ARG VITE_API_ORIGIN
ENV VITE_API_ORIGIN=${VITE_API_ORIGIN}
RUN corepack pnpm --filter @lyonix/web build

FROM nginx:1.27-alpine AS web
COPY infra/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
