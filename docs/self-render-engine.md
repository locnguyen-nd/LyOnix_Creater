# Engine tự render (FFmpeg) — kiến trúc và vận hành

Engine nội bộ `lyonix` dựng video 1080×1920, **60 fps CFR** bằng FFmpeg trong `apps/media-worker`. Creatomate và Orshot vẫn là engine dự phòng và hành vi của chúng không đổi khi Router chọn chúng. Kế hoạch gốc và tiến độ từng task: [`docs/plans/self-render-engine.md`](plans/self-render-engine.md) (mục 6 ghi giới hạn trung thực).

## 1. Luồng dữ liệu

```
Studio / Auto ──► RenderJobsService (API)
                    │  Router (packages/domain/render-router.ts): chọn engine, ghi engine + routeReason
                    ├─ creatomate / orshot ─► đường cũ (không đổi)
                    └─ lyonix ─► InternalRenderService
                                   preparing_clips → rendering → verifying → completed | failed
                                   │  compose-plan.ts: timeline + media + audio ─► ComposePlan (RenderPlan IR, đơn vị frame @60 fps)
                                   ▼  RabbitMQ queue `lyonix.render`, message `video.compose` (jobKey + fingerprint idempotent)
                              apps/media-worker/src/compose
                                   filtergraph.ts   cảnh → xfade/concat, cover-scale BT.709, zoom ảnh
                                   audio-graph.ts   giọng đặt chính xác theo mẫu, nhạc ducking, loudnorm 2 pass → AAC
                                   overlays.ts      phụ đề + text layer thành ASS (libass), cùng hàm ngắt dòng với player Studio
                                   compose-processor.ts  chạy FFmpeg, tiến độ (`video.compose.progress`), QC, ghi file
                                   ▼  MEDIA_ROOT/working/renders/<hash>/video.mp4 (+ thumbnail), TTL 7 ngày
              API phát lại tại GET /render-jobs/:id/file | thumbnail (hỗ trợ Range)
```

Quy tắc cứng: FFmpeg **chỉ** chạy trong `apps/media-worker`; không S3/MinIO; không có provider giả ở runtime (thiếu worker ⇒ job lỗi có mã, không giả lập thành công).

## 2. Render Router

Thứ tự luật, khớp đầu tiên thắng (`routeRender`, hàm thuần):

1. Admin ép engine (`forceEngine`) → engine đó (`forced`).
2. Mẫu thuộc nhà cung cấp → nhà cung cấp đó (`template_requires_provider` / `orshot_template`), hành vi cũ.
3. Mẫu nội bộ: ngoài `rolloutPercent` → `canary_holdout`; engine nội bộ không có consumer → `local_unhealthy`; hàng đợi quá SLA và bật overflow → `overflow`; còn lại → `lyonix` (`default`).
4. Lỗi **kỹ thuật** của engine nội bộ → dự phòng **một lần** sang mẫu provider tương đương (`fallback_after_error`). Lỗi dữ liệu đầu vào (`COMPOSE_ERROR_CODES` loại input) không dự phòng; không dự phòng lần hai.

Mọi dự phòng sang provider bị chặn bởi trần chi phí (mặc định 50 USD/ngày UTC): hết trần ⇒ job `failed` mã `RENDER_BUDGET_EXHAUSTED` (`budget_exhausted`), **không gọi provider**. Job dự phòng có id `fallback:<jobGốc>` và `fallbackOfJobId`, được tạo trước khi job gốc bị đánh lỗi.

`rolloutPercent` mặc định **0** (không job nào dùng engine nội bộ cho đến khi admin bật). Job được gán vào bucket cố định theo FNV-1a của `snapshotId:jobKey`, nên cùng job luôn cùng kết quả.

## 3. Biến môi trường

| Biến | Nơi đọc | Mặc định | Ý nghĩa |
|---|---|---|---|
| `MEDIA_WORKER_RENDER_QUEUE` | api + media-worker | `lyonix.render` | Queue riêng của `video.compose`, để render dài không chặn `clip.prepare`. |
| `MEDIA_WORKER_RENDER_PREFETCH` | media-worker | `1` | Số render song song (1..4, không quá số CPU). Một encode 1080p60 đã dùng hết lõi. |
| `RENDER_X264_PRESET` | media-worker | `faster` | Preset x264 (`ultrafast`…`slow`). Preset là đánh đổi tốc độ/kích thước, không đổi định dạng đầu ra. |
| `RENDER_X264_THREADS` | media-worker | `0` | Số thread mỗi render (0 = FFmpeg tự chọn). |
| `RENDER_JOB_TIMEOUT_MS` | media-worker | `900000` | Giới hạn thời gian thực của một lần chạy FFmpeg. |
| `RENDER_FONTS_DIR` | media-worker | rỗng | Thư mục phông bổ sung cho libass (ngoài phông hệ thống). |
| `RENDER_FALLBACK_DAILY_USD` | api | `50` | Trần chi phí dự phòng sang provider mỗi ngày UTC. |
| `RENDER_FALLBACK_MONTHLY_USD` | api | không giới hạn | Trần theo tháng UTC (tuỳ chọn). |
| `RENDER_OVERFLOW_ENABLED` | api | tắt | `true` để cho phép chuyển sang provider khi hàng đợi nội bộ quá dài. |
| `RENDER_OVERFLOW_SLA_MS` | api | `600000` | Thời gian chờ ước tính vượt ngưỡng này thì `overflow`. |
| `RENDER_LOCAL_USD_PER_CPU_HOUR` | api | `0` | Giá ước tính mỗi CPU-giờ của máy render; chi phí job nội bộ = CPU-giây / 3600 × giá. `0` = chưa biết/miễn phí. |

Phông: image `media-worker` cài `fontconfig fonts-noto-cjk` (Noto Sans CJK JP). Thiếu phông mà recipe cần ⇒ job lỗi `FONT_MISSING` (lỗi kỹ thuật ⇒ Router dự phòng), không render bằng phông thay thế âm thầm.

## 4. Chuẩn đầu ra và QC

Mọi video phải qua cổng QC trước khi `completed`; báo cáo đầy đủ nằm ở `RenderJob.qcReport` (giữ cả khi lỗi).

| Mã | Điều kiện |
|---|---|
| `QC_RESOLUTION` | 1080×1920 |
| `QC_FPS` | 60/1 CFR, đúng số frame của plan |
| `QC_CODEC` | H.264 High, yuv420p |
| `QC_DURATION` | khớp tổng giọng + đệm đầu/cuối trong dung sai 100 ms |
| `QC_AUDIO` | AAC-LC 48 kHz stereo |
| `QC_LOUDNESS` | −14 LUFS ±1 LU |
| `QC_TRUE_PEAK` | ≤ −1 dBTP |
| `QC_BLACK_FRAMES` | không có đoạn đen ≥ 200 ms |
| `QC_FREEZE` | không có đoạn đứng hình ≥ 1 s (bỏ qua khi ảnh tĩnh chủ ý: tắt animation ảnh) |

Các ngưỡng `QC_BLACK_FRAMES`/`QC_FREEZE` mới chỉnh bằng video tổng hợp, **chưa hiệu chỉnh trên footage thật**.

## 5. Recipe (mẫu nội bộ)

Recipe là object TypeScript bất biến, có phiên bản, trong `packages/render-recipes/src/recipes/`; `validateRecipe` kiểm tra khi nạp. `schemaVersion: 1`; chỉ **thêm** trường tuỳ chọn, không đổi nghĩa trường cũ.

Phần chính: `timing` (đệm đầu/cuối), `transition` (`none|fade|wipe|slide|circle`), `background` (chuyển động ảnh/video, `tint`, tuỳ chọn `frame` = dải ảnh trên nền màu), `layers` (`box` và `text`, `visibleIfSlot`), `captions` (phông, cỡ, `highlight: word|none`, tuỳ chọn `placement` top/bottom và `colorCycle`), `audio` (nhạc nền/ducking 12 dB, −14 LUFS, −1 dBTP), `slots` (tuỳ chọn người dùng đổi, cùng dạng với slot của template provider), `fonts`.

Mẫu hiện có: `news-recap-broadcast-telop-jp@1`, `news-recap-white-top-caption-jp@1`, `news-recap-photo-video-mix-jp@1`. Hai mẫu sau là **bản xấp xỉ** từ mô tả template Creatomate (không có JSON gốc); A/B với bản Creatomate do owner thực hiện ở máy local.

An toàn TikTok: chữ nằm ngoài 10 % trên, 20 % dưới và 12 % hai bên; test kiểm tra điều này cho mọi recipe phát hành.

### Thêm một mẫu mới

1. (Nếu có JSON Creatomate/Orshot) `corepack pnpm template:lint <file.json>` để biết mẫu thuộc nhóm A (engine nội bộ dựng được) hay B (cần provider) và dùng phông/hiệu ứng gì.
2. Tạo `packages/render-recipes/src/recipes/<id>.v1.ts` xuất một `RenderRecipe`; đăng ký trong `registry.ts` (`RELEASED_RECIPES`) và `index.ts`.
3. Thêm digest của recipe vào test `render-recipes.test.ts` (ghim bất biến: đổi nội dung = bản `version` mới, không sửa bản đã phát hành).
4. Chạy `corepack pnpm --filter @lyonix/render-recipes test` và test tích hợp `compose.integration.test.ts` (cần FFmpeg; phông được thay bằng phông máy).
5. API tự đồng bộ recipe thành `TemplateSnapshot` `engine=lyonix` khi khởi động (idempotent, `rolloutPercent` bắt đầu = 0, không ghi đè lựa chọn của admin). Gắn mẫu provider tương đương làm dự phòng trong Settings → *Render nội bộ*, rồi mới tăng `rolloutPercent`.
6. So sánh với bản Creatomate bằng `corepack pnpm render:parity` ở máy local (cần key Creatomate; SSIM/PSNR/VMAF, độ lệch phụ đề, loudness).

### Thêm một hiệu ứng mới

Một hiệu ứng chỉ được dùng trong recipe khi engine dựng được và QC bắt được lỗi của nó:

1. Mở rộng kiểu và `validateRecipe` trong `schema.ts` (trường **tuỳ chọn**, có kiểm tra phạm vi); recipe cũ không đổi.
2. Cài đặt trong `apps/media-worker/src/compose/` (`filtergraph.ts` cho hình, `overlays.ts`/`caption-ass.ts` cho chữ, `audio-graph.ts` cho tiếng) — hàm thuần, trả chuỗi filter để test không cần FFmpeg.
3. Test đơn vị cho filtergraph/ASS và một test tích hợp render thật qua đủ QC.
4. Cập nhật `packages/providers/src/template-lint.ts` (danh sách hỗ trợ) để lint phân loại đúng.
5. Nếu thay đổi làm đổi byte đầu ra của recipe hiện có, tăng `outputProfileVersion` (`compose.v1` → `v2`).

## 6. Vận hành

- Admin: *Settings → Render nội bộ* (`GET /admin/render-engine`, `PATCH /admin/render-engine/templates/:id`). `rolloutPercent > 0` bắt buộc có ≥ 1 mẫu provider dự phòng. Số liệu (job theo engine, QC lỗi theo mã, p50/p95, dự phòng theo lý do, chi phí theo ngày, ngân sách dự phòng) tính từ các dòng `RenderJob` thật; chi phí là **ước tính** ghi lúc render, không phải hoá đơn của provider.
- Ép engine khi thử: chỉ admin, ở màn Render (không gửi `forceEngine` = Router tự chọn).
- Công cụ dev: `corepack pnpm --filter @lyonix/media-worker compose:cli` chạy một job `video.compose` không cần RabbitMQ; `corepack pnpm render:parity`; `corepack pnpm template:lint`.
- Test tích hợp cần FFmpeg (libx264, libass, xfade, loudnorm) và **bị bỏ qua trên CI**; chạy local. Test số liệu admin trên PostgreSQL thật bật bằng `LYONIX_TEST_DATABASE_URL`.

## 7. Giới hạn đã biết

- Chưa đo bộ nhớ/thời gian trên máy đích; số đo cloud chỉ để tham khảo.
- Player xem thử Studio là xấp xỉ (không có timing từng chữ và chuyển cảnh).
- Độ rộng chữ khi ngắt dòng là ước tính theo từng ký tự, không đo phông thật.
- Chi phí nội bộ phụ thuộc `RENDER_LOCAL_USD_PER_CPU_HOUR` do owner đặt.
