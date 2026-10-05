# LyOnix trong Docker (test: PC Windows + Cloudflare Tunnel)

Luồng: `git push dev` → GitHub Actions build image (amd64+arm64) → GHCR `:dev` → Watchtower trên máy chủ pull và restart → API tự chạy `prisma migrate deploy`.

## Thiết lập một lần

1. **GitHub**: Settings → Secrets and variables → Actions → *Variables*: `VITE_API_ORIGIN=https://api.<DOMAIN>`.
   Push lên `dev` (hoặc chạy workflow *Docker images (dev)* thủ công) để có image đầu tiên.
2. **Cloudflare**: Zero Trust → Networks → Tunnels → tạo tunnel (Docker), copy token. Thêm 2 Public Hostname:
   - `app.<DOMAIN>` → `http://web:80`
   - `api.<DOMAIN>` → `http://api:3000`
3. **Máy chủ**: copy thư mục `infra/docker` (hoặc chỉ `docker-compose.yml` + `Caddyfile`), rồi:
   ```bash
   cp .env.example .env   # điền DOMAIN, token, mật khẩu, JWT_SECRET, PERSISTENCE_ENCRYPTION_KEY...
   docker compose up -d
   ```
   Package GHCR private: tạo PAT `read:packages`, điền `GHCR_USER`/`GHCR_TOKEN`, và chạy một lần `docker login ghcr.io`.
4. Docker Desktop: bật *Start when you sign in*, tắt sleep của PC.

## Vận hành

- Cập nhật code: không cần làm gì (Watchtower poll 60s).
- Đổi `docker-compose.yml` hoặc `.env`: `docker compose pull && docker compose up -d` (Watchtower chỉ cập nhật image).
- Rollback: đặt `IMAGE_TAG=sha-<commit>` trong `.env` rồi `docker compose up -d` (Watchtower sẽ không đè tag cố định).
- Log: `docker compose logs -f api media-worker`.

## Engine tự render (media-worker)

- Image `media-worker` có FFmpeg và phông Noto Sans CJK; render nội bộ chạy ở queue `lyonix.render` (biến `MEDIA_WORKER_RENDER_*`, `RENDER_*` trong `.env`, xem `.env.example`). Chi tiết: [`docs/self-render-engine.md`](../../docs/self-render-engine.md).
- Video ra nằm ở volume `app-data` (`working/renders/`), tự xoá sau 7 ngày; API phát lại qua `/render-jobs/:id/file`.
- Mặc định **không job nào** dùng engine nội bộ (`rolloutPercent = 0`): bật theo mẫu ở Settings → *Render nội bộ* (admin) sau khi đã gắn mẫu provider dự phòng.
- Một render 1080p60 dùng hết các lõi CPU: giữ `MEDIA_WORKER_RENDER_PREFETCH=1` trên máy PC; máy yếu thì đổi `RENDER_X264_PRESET` sang `veryfast`.
- Trần chi phí dự phòng sang provider: `RENDER_FALLBACK_DAILY_USD` (mặc định 50 USD/ngày).

## Chuyển sang VPS

Copy `docker-compose.yml` + `.env` (+ `Caddyfile`). Không mở được cổng thì giữ `COMPOSE_PROFILES=tunnel`; có IP/domain công khai thì đặt `COMPOSE_PROFILES=caddy`.

## Lưu ý

- Watchtower dùng fork `nickfedor/watchtower` vì bản `containrrr` không tương thích Docker Engine mới.
- Quy ước repo: không S3, FFmpeg chỉ trong image `media-worker`, không commit `.env`.
- Mật khẩu/secret thật chỉ nằm ở `.env` trên máy chủ.
