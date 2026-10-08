# Tải media bằng yt-dlp / gallery-dl (VE2E-144…149)

Quyết định: `CR-MEDIA-OSS-FETCH-2026-10-08`, `DEC-2026-10-08-SOCIAL-FETCH-OSS` (repo tài liệu `D:\LyOnix\.docs\changes\`).
Mọi cờ phía API mặc định **tắt**; chỉ bật sau khi chạy `fetch:probe` thật trên máy đích.

## Luồng

```
API (MediaPlanService / ApifyService)
  └─ SocialFetchService ── thang khắc phục phía API: plain → xoay cookies (≤2) → proxy → trả lỗi cho thang media
        │   cầu dao theo nền tảng (403/bot-check/cookies/429 ≥ 50% trong 10 phút → bỏ qua 15 phút, rồi 1 lượt thử)
        ▼ RabbitMQ lyonix.media.fetch (cookies KHÔNG nằm trong message: file 0600 _private/cookies/<uuid>.txt, xóa ngay)
media-worker SocialFetchProcessor ── thang khắc phục trong worker: plain → trích xuất lại (403/mạng/timeout) → --impersonate chrome (403/bot-check)
  └─ yt-dlp / gallery-dl → MEDIA_ROOT/_quarantine/<uuid> (stream, --max-filesize) → API sniff + registerAsset
```

| Điểm nối | Cờ | Hành vi |
|---|---|---|
| TikTok phase 2 (bài đã chọn từ kết quả tìm Apify) | `MEDIA_FETCH_YTDLP=1` | yt-dlp tải thay Actor; lỗi → Apify phase 2 như cũ. Asset vẫn `origin: apify` (ứng viên + provenance của Apify), `serverProvenance.downloader` ghi yt-dlp |
| Tầng `shorts` (slot video) | `MEDIA_SOURCE_YT_SHORTS=1` | `ytsearch` (từ khóa ja rồi en bám chủ thể) → lọc (≤ `MEDIA_SHORTS_MAX_SECONDS`=180 s, dọc, chưa dùng, nêu chủ thể) → tải ≤ 2 bài. Ưu tiên: ja > en > shorts > broad > Pexels |
| Tầng `gallery` (slot ảnh) | `MEDIA_FETCH_GALLERYDL=1` | gallery-dl Pinterest search (hoặc X: `MEDIA_GALLERY_PLATFORM=x`, cần cookies). Ưu tiên sau broad, trước Pexels |

Asset của tầng mới: `origin: social` (migration `20261008120000_ve2e_147_media_origin_social`, chỉ thêm giá trị enum), tên `social-<platform>-<id>.<ext>`,
`strip_audio`, reframe mặc định bật (`REFRAME_ENABLED_ORIGINS` mặc định `apify,social`). Client không thể tự đặt origin `social`.

## Cài đặt

- Docker: image `media-worker` đã có Python venv `/opt/socialfetch` với `yt-dlp[default,curl-cffi]` + `gallery-dl` **ghim phiên bản** (ARG
  `YTDLP_VERSION`, `GALLERY_DL_VERSION`) và Deno (`DENO_VERSION`). Cập nhật = đổi ARG + build lại; worker không tự `-U`.
- Máy dev (Windows): `pip install "yt-dlp[default,curl-cffi]" gallery-dl`, cài Deno ≥ 2.3 (YouTube), hoặc trỏ `YTDLP_PATH` / `GALLERY_DL_PATH`.
  Thiếu công cụ chỉ làm job `media.fetch` trả `FETCH_TOOL_MISSING` (API rơi về Apify); các job khác không ảnh hưởng.

## Cookies

Trang Providers → Thêm tài khoản → `social_cookies` → chọn nền tảng → dán `cookies.txt` (Netscape, xuất bằng tiện ích trình duyệt từ **tài khoản phụ**).
Server chỉ giữ dòng của domain nền tảng đó, mã hóa như mọi secret, không bao giờ trả lại. Verify không gọi nền tảng (kiểm định dạng/domain/hạn).
Khi dùng: `FETCH_COOKIES_INVALID` → tài khoản `failed`; bot-check/429 → nghỉ `MEDIA_FETCH_COOKIE_COOLDOWN_MS` (30 phút). Thẻ hiện cảnh báo khi còn < 3 ngày.

## Đo thật trước khi bật

```bash
corepack pnpm --filter @lyonix/media-worker fetch:probe -- --urls probe-urls.txt          # "<platform> <url>" mỗi dòng
corepack pnpm --filter @lyonix/media-worker fetch:probe -- --search youtube "メッシ 引退" --limit 5
corepack pnpm --filter @lyonix/media-worker fetch:probe -- --urls probe-urls.txt --cookies cookies.txt --json
```

Báo cáo: tỉ lệ thành công / bị chặn, p50/p95 thời gian tải, các bước khắc phục đã dùng. File tải về bị xóa khi xong (trừ `--keep`).
Sau khi bật: `report:failures` có dòng `ossFetch` (yt-dlp vs rơi về Apify, mã lỗi, p50/p95) và `sourceProvider social`, tier `shorts`/`gallery`.

## Giới hạn trung thực

- Chưa có số đo thật (máy dev chưa cài công cụ ở thời điểm code). Tỉ lệ 403 từ IP máy chủ chưa biết.
- yt-dlp không tìm TikTok theo từ khóa (`tiktok:tag` "Currently broken" upstream) → bước tìm TikTok vẫn là Apify.
- Tầng `shorts`/`gallery` chưa có kiểm duyệt vision lúc lập kế hoạch như đường Apify; chỉ có lọc metadata + cổng chủ thể, sau đó reframe + quality gate.
- Tải từ YouTube/TikTok/Pinterest/X trái điều khoản nền tảng — rủi ro do chủ dự án chấp nhận (DEC).
