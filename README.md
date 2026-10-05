## Về dự án

LyOnix Creater là một nền tảng giúp quản lý nhiều kênh TikTok, lên kế hoạch nội dung và tự động hóa quy trình sản xuất video từ một giao diện duy nhất.

## Tính năng chính

- Quản lý nhiều kênh TikTok
- Lập kế hoạch và lịch đăng nội dung
- Sản xuất video ngắn theo quy trình tự động
- Quản lý media và tài sản nội dung
- Theo dõi hiệu suất nội dung

## Công nghệ

Dự án đang được phát triển theo mô hình nền tảng nội dung sáng tạo và quản lý kênh TikTok.

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

## Media worker (FFmpeg)

`apps/media-worker` là process duy nhất chạy FFmpeg (không bao giờ trong HTTP request). Nó consume job
`clip.prepare` từ RabbitMQ (`MEDIA_WORKER_QUEUE`, mặc định `lyonix.media`) và trả kết quả về `replyTo` kèm
`correlationId`. Contract + client enqueue/await: `packages/media-jobs`.

- Cần `ffmpeg` + `ffprobe` (có `libx264`) trên PATH, hoặc đặt `FFMPEG_PATH` / `FFPROBE_PATH`. Thiếu binary thì
  worker thoát với thông báo rõ ràng và `pnpm dev` dừng mọi worker (bắt buộc từ VE2E-37 vì render cắt clip qua worker này).
- Cần RabbitMQ (`infra/compose`, `RABBITMQ_URL`); worker tự kết nối lại với backoff.
- Output ở `MEDIA_ROOT/working/media-jobs/` (retention `working`, TTL 7 ngày, local disk, không S3).
- Render timeline có dải nguồn (VE2E-37) gửi clip derivative đã cắt, không bao giờ gửi file gốc; worker lỗi/timeout →
  render lỗi `MEDIA_PREPARE_FAILED` (retry được). Chờ tối đa `MEDIA_PREPARE_TIMEOUT_MS` (mặc định 180000) mỗi clip.
- `corepack pnpm dev` / `corepack pnpm --filter @lyonix/worker start` khởi động audio + workflow + media worker.
- Test tích hợp FFmpeg thật: `corepack pnpm --filter @lyonix/media-worker test` (tự skip nếu không có FFmpeg).

## Studio UI (I03-02 fixture)

```powershell
corepack pnpm --filter @lyonix/web dev
```

Open `http://localhost:5173`. Local demo accounts (not production secrets):

- `admin@lyonix.local` / `lyonix-admin`
- `staff@lyonix.local` / `lyonix-staff`

Session and demo data stay in the browser. Nest session auth is task I03-01.
"C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:3000
Nền tảng quản lý kênh TikTok và tự động sản xuất video ngắn.


## Cài đặt

```bash
git clone https://github.com/locnguyen-nd/LyOnix_Creater.git
cd LyOnix_Creater
```

## Tác giả

- [locnguyen-nd](https://github.com/locnguyen-nd)

## License
********
