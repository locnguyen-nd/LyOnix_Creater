# LyOnix Creater

Nền tảng quản lý kênh TikTok và sản xuất video ngắn, render qua Vrew.

## Monorepo

- `apps/web` — React/Vite Studio
- `apps/api` — NestJS REST API và OpenAPI
- `apps/worker` — workflow worker
- `apps/media-worker` — media processing boundary; FFmpeg chỉ chạy tại đây
- `packages/contracts` — REST types và OpenAPI 3.1 base
- `packages/db` — Prisma/PostgreSQL
- `packages/providers` — provider adapter ports
- `infra/compose` — PostgreSQL và RabbitMQ local

Node 24+ và Corepack/pnpm được yêu cầu.

```powershell
corepack pnpm install
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

## Studio UI (I03-02 fixture)

```powershell
corepack pnpm --filter @lyonix/web dev
```

Open `http://localhost:5173`. Local demo accounts (not production secrets):

- `admin@lyonix.local` / `lyonix-admin`
- `staff@lyonix.local` / `lyonix-staff`

Session and demo data stay in the browser. Nest session auth is task I03-01.
