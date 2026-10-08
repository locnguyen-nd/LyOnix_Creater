# syntax=docker/dockerfile:1.7
# Build context = repo root:  docker build -f infra/docker/Dockerfile --target <app|media-worker|web> .
ARG NODE_VERSION=24
# VE2E-144: Deno = JS runtime for yt-dlp's YouTube challenges (media-worker only); a named stage because COPY --from cannot expand ARGs.
ARG DENO_VERSION=2.5.0
FROM denoland/deno:bin-${DENO_VERSION} AS deno-bin

# ---- deps: cache pnpm store from lockfile only (re-runs only when pnpm-lock.yaml changes)
FROM node:${NODE_VERSION}-bookworm-slim AS deps
ENV PNPM_HOME=/pnpm CI=true
# onnxruntime-node would download a ~GB CUDA package at install; containers here are CPU-only.
ENV ONNXRUNTIME_NODE_INSTALL_CUDA=skip
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
# fonts-noto-cjk = "Noto Sans CJK JP" (burned-in Japanese text of the internal render engine, recipes in packages/render-recipes);
# fontconfig provides fc-list, which the worker uses to fail fast with FONT_MISSING instead of silently rendering tofu/fallback glyphs.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fontconfig fonts-noto-cjk python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*
# VE2E-144 (CR-MEDIA-OSS-FETCH): yt-dlp + gallery-dl for media.fetch / media.search, PINNED (upgrade = bump the ARG and rebuild; the
# worker never self-updates with `-U`). `default` brings yt-dlp-ejs (YouTube JS challenges), `curl-cffi` the --impersonate targets.
# Deno is the JS runtime yt-dlp-ejs needs for YouTube (yt-dlp 2026.06.09 requires Deno >= 2.3.0).
ARG YTDLP_VERSION=2026.08.19
ARG GALLERY_DL_VERSION=1.32.15
COPY --from=deno-bin /deno /usr/local/bin/deno
RUN python3 -m venv /opt/socialfetch \
    && /opt/socialfetch/bin/pip install --no-cache-dir "yt-dlp[default,curl-cffi]==${YTDLP_VERSION}" "gallery-dl==${GALLERY_DL_VERSION}" \
    && ln -s /opt/socialfetch/bin/yt-dlp /usr/local/bin/yt-dlp && ln -s /opt/socialfetch/bin/gallery-dl /usr/local/bin/gallery-dl
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
