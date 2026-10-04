# Engine tự render `lyonix` (FFmpeg, 60 fps) — Creatomate/Orshot làm dự phòng

Chủ dự án quyết định 04/10/2026 (DEC-2026-10-04-SELF-RENDER-60FPS, nằm ở repo tài liệu `D:\LyOnix\.docs\changes\`, không có trong repo này).
File này là **bản giao việc tự đủ** cho phiên cloud: đọc hết trước khi code. Nhánh: `feat/self-render-engine` (từ `origin/dev` b0b7e66). PR vào `dev`.

## GOAL (Definition of Done của phiên cloud)

Phiên cloud chỉ coi là xong khi **tất cả** điều sau đúng và có bằng chứng trong mục "Cập nhật" cuối file:

1. Engine nội bộ `lyonix` render được mẫu **broadcast-telop** (và nếu kịp, photo-video-mix + white-top-caption) từ một `TimelineVersion` thật trong test, ra MP4 **1080×1920, 60 fps CFR**, đạt **toàn bộ tiêu chuẩn chất lượng §3**, kiểm bằng QC tự động (FFmpeg/ffprobe thật trong integration test, không mock FFmpeg).
2. **Cả hai luồng** dùng được engine: Auto (`WorkflowRunnerService` → `enqueueTimelineRender`) và Studio (submit từ timeline) đi qua **Render Router**; Creatomate/Orshot vẫn chạy y như trước khi Router chọn chúng (test hồi quy xanh).
3. **Fallback**: engine nội bộ lỗi kỹ thuật/QC không đạt → tạo 1 job dự phòng Creatomate (có `fallbackOfJobId`, `routeReason`), có test; trần ngân sách chặn dự phòng khi vượt.
4. `costAmount` (và thời gian render) ghi cho cả 3 engine.
5. `corepack pnpm typecheck`, `corepack pnpm lint`, `corepack pnpm test` xanh toàn repo (ghi số test); integration test FFmpeg của media-worker xanh.
6. i18n vi/en/ja/ko đủ cho mọi chuỗi UI mới (test parity xanh).
7. Engine nội bộ **mặc định `rolloutPercent = 0`** cho tới khi chủ dự án duyệt A/B (không tự bật cho người dùng).
8. Đã push nhánh và mở PR vào `dev`; mô tả PR liệt kê task VE2E-1xx đã làm, số test, giới hạn trung thực, việc còn lại cho local.

Không được tuyên bố "xong"/"done"/UAT; trạng thái tối đa của mỗi task là `code_done`.

## 1. Bối cảnh và số liệu

- Mục tiêu: 3.000 video/ngày (cao điểm 8 giờ ≈ 6,3 video/phút), 100 người dùng đồng thời, video ≥ 70 s ở **60 fps**.
- Chi phí render 70 s 1080p60: Creatomate ≈ $0,52/video (87 credit, công thức `w×h×fps×s÷1e8`), Orshot ≈ $0,33 (1 credit/giây), FFmpeg tự render ≈ $0,01 (ước tính ~300 CPU-giây/video ở 60 fps, **chưa đo** — VE2E-101 đo).
- Số đo pipeline hiện tại (DB dev): `import_media` p50 15 s / p95 184 s; script p50 13 s; TTS p50 0,7 s/cảnh; render Creatomate p50 ~82 s.
- Máy chạy trước mắt là laptop i5-8350U 4C/8T, 16 GB (Docker 8 GB), Intel UHD 620. Thiết kế phải chạy tốt khi chỉ có ~8 luồng CPU: hàng đợi render riêng, prefetch thấp, số luồng x264 cấu hình được.
- 4 mẫu Creatomate hiện có (`creatomate-templates/` ở repo tài liệu): 3 mẫu news (`news-recap-broadcast-telop-jp`, `news-recap-photo-video-mix-jp`, `news-recap-white-top-caption-jp`) chỉ dùng fade/wipe/scale → nhóm A (làm lại bằng FFmpeg). `top-5-countdown-japan-vibrant` dùng flip, text-scale theo chữ, circular-wipe, slide → nhóm B (`providerOnly`, giữ Creatomate). Phông: Noto Sans JP, M PLUS Rounded 1c (Google Fonts, OFL). Nếu cloud không có các file JSON mẫu, lấy cấu trúc qua `TemplateSnapshot.rawTemplate`/fixture trong `packages/providers/src/fixtures` hoặc dựng recipe theo mô tả: chữ telop dải ngang, badge, phụ đề dưới, chuyển cảnh wipe 0,25–0,5 s, scale nhẹ.

## 2. Kiến trúc

```
Studio / Auto → TimelineVersion (đã duyệt) → chuẩn bị clip (clip.prepare, reframe — đã có)
  → RenderPlan IR (packages/domain, thuần) → Render Router (thuần)
      ├─ lyonix  → RabbitMQ lyonix.render → media-worker video.compose → QC → completed (MEDIA_ROOT, TTL 7 ngày, link media-delivery)
      │            └─ lỗi kỹ thuật/QC → fallback 1 lần → Creatomate
      ├─ creatomate → creatomate-dynamic.ts / template path (giữ nguyên)
      └─ orshot     → orshot.ts (giữ nguyên, PR #40)
```

- **RenderPlan** là đầu vào chung: canvas, fps, danh sách cảnh (thời điểm, độ dài, media đã cắt `relativePath`, loại ảnh/video, hiệu ứng vào/ra), giọng đọc theo cảnh, phụ đề theo từ (từ `SubtitleVersion`/alignment), chữ (title/caption/screenText theo quy tắc hiện có: chữ hiển thị = narration), nhạc nền, tham số mẫu. Bộ dựng composition Creatomate hiện có nên dần đọc từ RenderPlan (không bắt buộc trong phiên này nếu rủi ro hồi quy).
- **Render Router** (thứ tự, khớp trước thì dừng): (1) admin ép engine → `forced`; (2) mẫu `providerOnly` → provider của mẫu, `template_requires_provider`; (3) mẫu Orshot và số cảnh = số slot → orshot, `orshot_template`; (4) mẫu đang canary và job ngoài tỷ lệ → dự phòng, `canary_holdout`; (5) engine nội bộ không khoẻ hoặc thời gian chờ ước tính > SLA → dự phòng nếu còn ngân sách, `overflow`/`local_unhealthy`; (6) mặc định `lyonix`, `default`. Sau lỗi kỹ thuật: `fallback_after_error` (1 lần, không áp cho lỗi dữ liệu đầu vào). Vượt trần ngân sách: `budget_exhausted` (không gọi provider). Mặc định cấu hình: tràn tải **tắt**, trần dự phòng `RENDER_FALLBACK_DAILY_USD=50`.
- **Engine nội bộ là một tài khoản render** `provider = "lyonix"` do hệ thống tạo (không secret) để Studio/Auto chọn như tài khoản khác; mẫu nội bộ là recipe JSON versioned trong repo (ví dụ `packages/render-recipes/` hoặc `apps/media-worker/recipes/`), ghim thành `TemplateSnapshot` (`rawTemplate` = recipe, `modifications` = slot cùng dạng hiện có).

## 3. Tiêu chuẩn chất lượng (AC chung — QC tự động kiểm phần đo được)

| Hạng mục | Tiêu chuẩn |
|---|---|
| Hình | 1080×1920, **60 fps CFR**; H.264 High, yuv420p, BT.709 (tv range); x264 CRF 18, preset cấu hình được (mặc định `faster`); GOP 2 s (120 khung); `-movflags +faststart` |
| Âm thanh | AAC-LC 48 kHz stereo 192 kb/s; −14 LUFS ±1 (ebur128 tích hợp); true peak ≤ −1 dBTP; nhạc nền hạ ~12 dB khi có lời (sidechain/volume theo cue) |
| Thời lượng | = tổng giọng đọc + đệm đầu/cuối của mẫu, lệch ≤ 100 ms |
| Phụ đề | Chữ hiển thị đúng từng chữ với lời đọc; lệch ≤ 1 khung (≈16,7 ms ở 60 fps); ≤ 2 dòng; tiếng Nhật ngắt dòng bằng BudouX (không ngắt giữa cụm từ) + kinsoku (không dấu câu `、。」』）！？` đầu dòng); quá 2 dòng → thu cỡ chữ tới ngưỡng tối thiểu rồi tách cue theo mốc từ; nằm trong vùng an toàn TikTok (tránh ~10% trên, ~20% dưới, ~12% phải) |
| Khung hình | Không khung đen ngoài chủ ý > 0,2 s (blackdetect), không đứng hình > 1 s (freezedetect), không viền đen sai tỉ lệ |
| Thành phẩm | Ảnh bìa JPG 1080×1920; RenderJob ghi `engine`, profile version, sha256, bytes, `renderDurationMs`, `costAmount` |

Video chỉ chuyển `completed` khi QC đạt (đúng VE2E-VIDEO-PRODUCTION §6). Clip nguồn 30 fps được nâng lên 60 fps bằng nhân khung (`fps=60`), không nội suy chuyển động (tránh méo hình).

## 4. Task (theo thứ tự làm; mã trùng `pipeline/state.json` ở repo tài liệu)

| ID | Việc | Nghiệm thu | Phụ thuộc |
|---|---|---|---|
| VE2E-102 | `packages/domain/src/render-plan.ts`: kiểu RenderPlan + `buildRenderPlan(timeline, snapshot, audio/subtitle/media refs, profile)` thuần | Test: cảnh `excluded`, trộn ảnh/video, đoạn nền + range nguồn, tổng thời lượng = tổng giọng, fps 60 | — |
| VE2E-108 | Migration **chỉ thêm cột**: `RenderJob.engine` (string, mặc định theo provider), `routeReason`, `fallbackOfJobId`; `TemplateSnapshot.engine`, `fallbackSnapshotIds` (Json), `rolloutPercent` (Int, mặc định 0). Cập nhật contracts | Migrate DB có dữ liệu cũ không lỗi; contracts test xanh | — |
| VE2E-101 | Spike `apps/media-worker/scripts/spike-compose.ts` (hoặc tương đương): dựng broadcast-telop 70 s 1080p60 từ fixture (clip test tự sinh bằng `testsrc2`/`sine` nếu không có media thật); đo CPU-giây (`/usr/bin/time -v` hoặc `process.cpuUsage` con) cho x264 `veryfast/faster/medium` | Bảng số đo trong mục Cập nhật (ghi rõ CPU của máy cloud, đây là số tham khảo); file video không commit | — |
| VE2E-103 | `packages/domain/src/caption-ass.ts`: ASS từ alignment theo từ; BudouX (`budoux` npm, model ja) + kinsoku; ≤ 2 dòng; tự thu cỡ/tách cue; highlight theo từ (`\k`/override màu); mốc thời gian làm tròn theo khung 60 fps | Test câu tiếng Nhật dài/ngắn, câu có dấu câu cuối dòng, tiếng Anh/Việt | 102 |
| VE2E-104 | `packages/media-jobs/src/compose-contract.ts`: `video.compose` job (jobKey, RenderPlan đã resolve đường dẫn tương đối `MEDIA_ROOT`, recipe id+version, profile) + result (output, QC report, thumbnail) + progress; `COMPOSE_PROFILE_VERSION`; hàng đợi mặc định `lyonix.render` | Test contract/fingerprint/idempotency như `clip.prepare` | 102 |
| VE2E-105 | `apps/media-worker/src/compose/`: recipe → filtergraph (scale/crop cover, zoompan/scale theo thời gian, `xfade` fade/wipe/slide/circle, overlay PNG/WebM alpha, `drawbox` shape, `subtitles`/`ass` qua libass với `fontsdir`, `amix` + duck + `loudnorm` 2 lượt hoặc 1 lượt có đo), encode theo §3, tiến độ từ `-progress`; consumer riêng `lyonix.render` (prefetch `MEDIA_WORKER_RENDER_PREFETCH`, mặc định 1; `RENDER_X264_THREADS`, `RENDER_X264_PRESET`); idempotent theo jobKey; file ra `working/renders/` TTL 7 ngày | Integration test FFmpeg thật: 3 cảnh, 60 fps, đúng kích thước/thời lượng | 103, 104 |
| VE2E-106 | QC trong media-worker: ffprobe (codec/profile/pix_fmt/fps/size/duration), ebur128 (LUFS/true peak), blackdetect/freezedetect, ảnh bìa; trả mã lỗi rõ (`QC_DURATION`, `QC_LOUDNESS`, `QC_BLACK_FRAMES`…) | Video lỗi cố ý bị chặn đúng mã | 105 |
| VE2E-107 | Schema recipe (zod hoặc kiểu + validator) + recipe `news-recap-broadcast-telop-jp@1`; image media-worker cài phông (Dockerfile `infra/docker`), `fontsdir` cấu hình | Recipe qua schema; render fixture đạt QC | 105 |
| VE2E-109 | `packages/domain/src/render-router.ts` thuần + trần ngân sách (tổng `costAmount` provider trong ngày/tháng từ DB do API truyền vào) | Test từng quy tắc + thứ tự ưu tiên | 108 |
| VE2E-111 | Kho mẫu: nạp recipe từ repo khi khởi động API, upsert `TemplateSnapshot` (engine `lyonix`) gắn tài khoản hệ thống `lyonix`; bảng ghép slot dự phòng → snapshot Creatomate; list template trả cả mẫu nội bộ | Mẫu nội bộ xuất hiện như mẫu provider; không cần secret | 108 |
| VE2E-110 | `RenderJobsService`: sau chuẩn bị clip → RenderPlan → Router → nhánh `lyonix` gửi `video.compose`, nhận kết quả qua reply queue (không poll), QC đạt → `completed` + `resultUrl` qua `media-delivery`; lỗi kỹ thuật → job dự phòng Creatomate 1 lần; ghi `costAmount`/`renderDurationMs` cho 3 engine (gồm VE2E-77: lấy `render_duration`/credit của Creatomate, ước tính Orshot đã có, nội bộ = CPU-giây × đơn giá cấu hình `RENDER_LOCAL_USD_PER_CPU_HOUR`, mặc định 0) | Test: nội bộ thành công; nội bộ lỗi → Creatomate; hết ngân sách → không gọi provider; hồi quy Creatomate/Orshot xanh | 106, 109 |
| VE2E-112 | Auto end-to-end: test tích hợp `WorkflowRunnerService` với provider HTTP stub + FFmpeg thật → MP4 60 fps qua QC; kịch bản fallback | Test xanh; ghi lại thời gian từng bước | 107, 110, 111 |
| VE2E-113 | Web: bộ chọn mẫu gộp có nhãn engine; Render "Tự động chọn" (admin ép engine); Jobs hiện engine/lý do/fallback/vị trí hàng đợi; i18n 4 ngôn ngữ; Creatomate/Orshot UI giữ nguyên | Test UI + i18n parity | 110 |
| VE2E-114 | Player Studio (VE2E-60) đọc RenderPlan + cùng hàm ngắt dòng (103) để xem thử khớp bản render | Test hàm dùng chung; ảnh chụp | 103, 113 |
| VE2E-116 | `pnpm render:parity`: render cùng timeline ở 2 engine (Creatomate cần key → chỉ chạy local), SSIM/VMAF tại khung chính, lệch phụ đề, báo cáo HTML | Chạy được với 2 file video đầu vào bất kỳ | 107 |
| VE2E-117 | `pnpm template:lint`: đọc JSON Creatomate/Orshot, liệt kê hiệu ứng/phông/slot, đánh dấu hỗ trợ | Phân loại đúng 4 mẫu (A/A/A/B) nếu có file | 105 |
| VE2E-115 | Recipe photo-video-mix + white-top-caption | Đạt QC; A/B chờ owner ở local | 107, 116 |
| VE2E-118 | `rolloutPercent` theo mẫu + số liệu (QC lỗi, fallback, render p50/p95, chi phí/ngày) trên trang admin | Số liệu từ DB thật trong test | 110 |
| VE2E-120 | Tài liệu trong repo: `docs/self-render-engine.md` (kiến trúc, env, recipe schema, thêm mẫu mới, thêm hiệu ứng mới), cập nhật `infra/docker/README.md`, env mới vào `.env.example` | Review | 112 |

**Không làm ở cloud** (để local): VE2E-100 (máy local), VE2E-119 (load test máy local), VE2E-121 (Orshot key thật), đo VE2E-101 trên máy đích, A/B với Creatomate thật, cập nhật `pipeline/state.json`/Trello/`.docs` (repo tài liệu không có ở cloud).

## 5. Luật bắt buộc

- FFmpeg **chỉ** chạy trong `apps/media-worker`, không trong request HTTP. Không S3/MinIO. Không CapCut. Không auto-post TikTok. 2 role `admin|staff` (ép engine chỉ admin). UI i18n vi/en/ja/ko.
- Không fake provider ở runtime; fake/stub chỉ trong test. Media-worker không chạy → `PROVIDER_NOT_CONFIGURED` hoặc fallback có ghi lý do, không giả lập thành công.
- Migration chỉ thêm cột, không sửa/xoá cột cũ. Không đổi hành vi Creatomate/Orshot khi Router chọn chúng.
- Không commit `.env`, secret, file video/benchmark lớn. Không gọi provider trả phí trong test.
- **Không attribution Claude** trong commit/PR: không `Co-Authored-By: Claude`, không "Generated with Claude Code", không link session. Commit theo nhóm chức năng, không force-push.
- Mock/fixture không phải bằng chứng live; ghi rõ giới hạn trung thực trong PR.

## 6. Cập nhật (cloud ghi tiến độ ở đây)

_(trống — mỗi task xong ghi: mã, commit, test chạy + số, giới hạn, việc còn lại)_
