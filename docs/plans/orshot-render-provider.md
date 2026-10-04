# Orshot — render provider thứ 2 + Studio dùng Orshot Embed

Chủ dự án yêu cầu 04/10/2026. Creatomate + Studio hiện tại giữ nguyên; Orshot là lựa chọn thứ 2 (tối ưu chi phí, khai thác điểm mạnh riêng).

## Trạng thái hiện tại (đã code local, đã commit trên nhánh này)

Giai đoạn A — adapter + tích hợp backend (xong, test xanh: providers 293, api 134, web 105):
- `packages/providers/src/orshot.ts`: probe key, list/get template (`/studio/templates/all`, `/studio/templates/:id`), slot từ `modifications`, render `POST /studio/render` mode async, poll `GET /studio/render-jobs/:id`. Webhook `render-webhooks/orshot/:token` chỉ kích hoạt reconcile.
- `CreatomateTemplatesService` / `RenderJobsService` / provider-accounts / capabilities rẽ nhánh theo `provider` (`creatomate|orshot`), không migration.
- Orshot luôn đi đường **template** (không có composition động N cảnh): Auto ép `template`, Studio dùng `render-jobs` thay `dynamic-render-jobs`.
- UI: Providers thêm Orshot; picker tài khoản render hiện "Tên · Provider"; Auto có chọn tài khoản render; i18n vi/en/ja/ko.

Giai đoạn B — điểm mạnh Orshot ở backend (code xong, **chưa chạy test/commit đủ**, cần Test):
- `contracts`: `OrshotRenderOptions` (format mp4/webm/mov/gif, fps 24/30/60, size preset, fitDurationToNarration), `OrshotCostEstimateResponse`, `RenderSubmitFromTimelineRequest.orshot`.
- `apps/api/src/orshot-render.ts` (thuần): whitelist option, giá credit (`ORSHOT_CREDIT_USD`, mặc định gói Grow 160/20000), trần độ dài (`ORSHOT_MAX_VIDEO_SECONDS`, mặc định 180), `estimateOrshotCost` (1 credit = 1 giây, làm tròn lên), tổng thời lượng narration.
- `RenderJobsService`: tính độ dài video = tổng narration → `videoOptions.duration`; `response.size` (smart resize), `fps`, format; ghi chi phí ước tính vào `RenderJob.costAmount/costCurrency` (USD) — hiển thị sẵn ở Jobs/Productions; chặn trước khi gọi provider nếu vượt trần gói; `estimateOrshotRender()` + route `GET /projects/:pid/timeline-versions/:tid/orshot-estimate`; option đi qua payload hàng đợi + fingerprint.

## Việc còn lại (giao cho cloud)

1. **Kiểm tra & test giai đoạn B**: `corepack pnpm --filter @lyonix/api exec tsc --noEmit`, `vitest run` (api, providers, web). Viết test cho `orshot-render.ts` (sanitize, estimate làm tròn, vượt trần), cho `planOrshotRender` (videoOptions.duration, size, fps), cho route estimate (draft timeline, quyền truy cập), cho adapter gửi `size`/`videoOptions`. Sửa mock `usableAccount` còn thiếu `provider` nếu có.
2. **Cấu hình Embed trên tài khoản**: tài khoản `orshot` lưu **Embed ID** (không phải secret) trong cột `model` (hiện đặt `"n/a"`). ProvidersPage: khi chọn Orshot, thêm ô "Embed ID" (+ hướng dẫn: bật *Enable Embed*, thêm origin vào *Allowed Domains*, bật *Enable Events*), cho sửa lại ở dialog edit; `hasModelChoice` vẫn ẩn model selector.
3. **Giao diện Orshot trong Studio** (`StudioProPage.tsx`, component mới `apps/web/src/studio/OrshotStudioPanel.tsx`): khi tài khoản render đang chọn là Orshot, thay vùng workspace/timeline bằng panel Orshot; vẫn có tab "Chuẩn bị cảnh" để quay về editor hiện tại (media/voice/script). Giữ nguyên 100% nhánh Creatomate. Panel gồm:
   - **Embed**: `<iframe src="https://orshot.com/embeds/{embedId}?templateId=…&lang=…[&userId=…]" allow="clipboard-write">` (không cần thêm dependency; hoặc `@orshot/embed-react` nếu cài được). Nghe `postMessage` chỉ từ origin `https://orshot.com`: `orshot:embed:ready` (cảnh báo nếu `eventsEnabled:false`), `orshot:template:create|update` (làm mới danh sách template, đề nghị ghim), `orshot:template:content`. Toggle "không gian riêng theo người dùng" (`userId`, cần gói Grow) mặc định tắt, lưu localStorage. JWT ký server là bước sau (cần secret thứ 2 → cần migration/CR).
   - **Template**: lưới template (thumbnail, tên, kích thước canvas), chọn → ghim snapshot (`pinTemplateSnapshot`) → gán vào timeline; bảng tương thích slot (số slot video/ảnh/text/audio của template so với số cảnh/media/voice của timeline) cảnh báo khi lệch.
   - **Tuỳ chọn render Orshot**: định dạng, fps, kích thước preset (smart resize), "khớp độ dài với narration" (mặc định bật).
   - **Chi phí**: gọi `orshot-estimate` mỗi khi timeline/tùy chọn đổi → hiển thị giây, credits, USD ước tính, cảnh báo vượt trần gói; ghi rõ là ước tính, Orshot không có API số dư credit; sau render hiện `costAmount` thực lưu trên job.
   - **Tiến trình**: trạng thái queued/processing/succeeded/failed của job Orshot (Orshot không trả % → hiển thị bước + thời gian đã chạy), nút Reconcile, kết quả video + tải về. Tái dùng `RenderProgress`/`getRenderJob` polling hiện có.
   - Nút Render gọi `submitRenderFromTimeline(..., { orshot: options })` (mở rộng `timeline-api.ts`).
4. **Auto**: màn tạo job Auto khi chọn tài khoản Orshot cho phép chọn format/size (tùy chọn ngắn) và hiện ước tính chi phí; chi phí thực ghi vào job (đã có đường `costAmount`).
5. **i18n** vi/en/ja/ko cho mọi chuỗi mới; thêm test i18n parity nếu repo có.
6. **Tài liệu/pipeline** (`D:\LyOnix`, ngoài repo này, làm ở máy local): tạo task + thẻ Trello, ghi `STATUS.md`; env mới `ORSHOT_CREDIT_USD`, `ORSHOT_MAX_VIDEO_SECONDS` vào `.env.example` và `08-DEPLOY`.
7. **Verify thật** (cần key Orshot của chủ dự án, không có trong cloud): render 1 template thật, xác nhận tham số `videoOptions.duration`, `response.size`, slot audio, định dạng `result.data`. Docs Orshot chưa nêu rõ audio/voiceover nên đây là rủi ro lớn nhất.

## Cập nhật 04/10/2026 (cloud) — đã làm

- Rebase sạch lên `origin/dev` (f612dc4); sửa 2 lỗi kiểu `exactOptionalPropertyTypes` của giai đoạn B.
- Việc 1: test cho `orshot-render.ts`, `planOrshotRender` (qua `submit`), `estimateOrshotRender`, adapter `size`/`videoOptions`.
- Việc 2: Embed ID lưu ở `model` (validate `^[A-Za-z0-9_-]{4,64}$` hoặc `n/a`), ô nhập ở ProvidersPage (thêm + sửa).
- Việc 3: `apps/web/src/studio/OrshotStudioPanel.tsx` (3 tab: Embed / Template + bảng tương thích slot / Render & chi phí), logic thuần + test ở `orshot-embed.ts`; chỉ tin `postMessage` từ `https://orshot.com` **và** đúng cửa sổ iframe; tab "quay về editor cũ"; Creatomate không đổi.
- Việc 4: Auto — chọn format/size cho tài khoản Orshot (`renderOptions` → `renderConfig.orshot` → `enqueueTimelineRender`), hiện ước tính credits theo thời lượng mục tiêu; USD thực ghi vào `costAmount` sau khi có lời đọc.
- Việc 5: i18n vi/en/ja/ko + test parity (`orshot-i18n.test.ts`).

Chưa làm / cần chủ dự án: việc 6 (ngoài repo) và việc 7 (verify với key thật). Không hiện kích thước canvas template trong lưới (API list không trả canvas). Màn Auto không hiện USD trước khi render vì giá credit phụ thuộc gói (`ORSHOT_CREDIT_USD` chỉ ở server).

## Giới hạn trung thực
- Orshot không dựng N cảnh động; số cảnh phải khớp slot template.
- Chi phí là ước tính (1 credit = 1 s × giá credit theo gói); không có API số dư/usage.
- Không dùng `publish` đăng mạng xã hội của Orshot (luật dự án: không auto-post).
- Chưa kiểm chứng với Orshot thật; mock/stub không phải bằng chứng live.

## Quy tắc
Không attribution Claude trong commit/PR; không commit secret; nhánh từ `origin/dev`, PR vào `dev`.
