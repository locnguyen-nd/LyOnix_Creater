# V04-XX — Xem trước template trước khi lựa chọn

## Trạng thái

`code_done` (2026-10-05): đã code và test xong, chờ chủ dự án kiểm tra và xác nhận `done`. Mã task chính thức vẫn chờ chủ dự án gán (thay `XX`). Kết quả triển khai ở mục 8.

Quyết định của chủ dự án (2026-10-05), trả lời mục 6: **1(a)** cả 3 màn hình; **2(a)** mô phỏng LyOnix ngay trong trình duyệt; **3(a)** có tab "Xem chuyển động" (Preview SDK), tuỳ chọn; tạm giữ mã `V04-XX`.

## 1. Mục tiêu

Người dùng xem trực quan template ngay trên giao diện **trước khi** áp dụng cho job:
- Mỗi template có nút **Xem trước**, mở khung 9:16.
- Xem trước **không** làm template được chọn; chỉ nút **"Chọn template này"** mới áp dụng.
- Không render thật, không tốn credit.
- Có trạng thái đang tải, lỗi và hiển thị thay thế (fallback).
- Tương thích với bản nháp (Save Draft) và tuỳ chọn mặc định (User Defaults) của VE2E-124.

## 2. Hiện trạng (đọc code ngày 2026-10-05)

### 2.1 Nơi đang chọn template

| Màn hình | File | Hành vi hiện tại |
|---|---|---|
| Tạo video, chế độ Auto | `apps/web/src/pages/JobNewPage.tsx` | Lưới ảnh 9:16; **bấm vào ảnh là chọn luôn** (`templateId`); có lưu vào draft và defaults |
| Thư viện template của Studio | `apps/web/src/pages/TemplateGalleryPage.tsx` | Lưới ảnh, lọc theo engine/tag; nút **Dùng template** ghim snapshot rồi quay về Studio |
| Panel Orshot trong Studio | `apps/web/src/studio/OrshotStudioPanel.tsx` | Lưới ảnh nhỏ; nút **Chọn** ghim snapshot |

### 2.2 Dữ liệu xem trước có sẵn

| Engine | Có sẵn | Ghi chú |
|---|---|---|
| Creatomate | Ảnh preview (`preview_image_url`) | Có thêm **Creatomate Preview SDK** (`studio/creatomate-preview.ts`): chạy template trong iframe của Creatomate, có chuyển động, **không tốn credit**. Cần `CREATOMATE_PREVIEW_PUBLIC_TOKEN` và chỉ chạy trên máy tính để bàn |
| Orshot | Ảnh thumbnail (`thumbnail_url`) | Không có video preview |
| LyOnix (engine nội bộ) | **Không có gì** (`previewUrl: null`) | Recipe là dữ liệu TypeScript (`@lyonix/render-recipes`), web import được |

Hiện **không provider nào trả về video preview** qua API danh sách template. "Video preview" chỉ làm được bằng Preview SDK (Creatomate) hoặc bằng mô phỏng/video mẫu (LyOnix), xem câu hỏi 2 và 3.

## 3. Phạm vi đề xuất

1. **Component dùng chung `TemplatePreviewModal`** (`apps/web/src/components/` hoặc `studio/`):
   - Khung 9:16 ở giữa màn hình; tên template, nhãn engine, tag.
   - Hai nút: **"Chọn template này"** và **Đóng**. Nếu đúng template đang được chọn thì hiện "Đang dùng template này".
   - Phím: Esc để đóng, ← / → để xem template trước/sau trong cùng danh sách.
   - Trạng thái: khung xương (skeleton) khi đang tải; ảnh lỗi thì chuyển sang fallback (tên + mô tả + "Không tải được ảnh xem trước"), không vỡ layout.
2. **Nội dung xem trước theo engine**:
   - Creatomate: ảnh preview. Tuỳ chọn tab **"Xem chuyển động"** dùng Preview SDK (câu hỏi 3).
   - Orshot: ảnh thumbnail.
   - LyOnix: theo câu hỏi 2.
3. **Thẻ template** ở cả 3 màn hình (phạm vi theo câu hỏi 1):
   - Bấm vào ảnh **mở xem trước** (không chọn nữa).
   - Mỗi thẻ có nút **Xem trước** (biểu tượng con mắt) và nút **Chọn**.
   - Template đang dùng có viền đậm và nhãn "Đang dùng".
4. **Không tốn credit**:
   - Ảnh lấy từ CDN của provider (giống hiện nay).
   - Preview SDK là bản xem trong trình duyệt, không gọi API render.
   - Mô phỏng LyOnix chạy hoàn toàn ở client.
   - **Không gọi ghim snapshot khi xem trước** (ghim chỉ xảy ra khi bấm "Chọn" ở Thư viện/Orshot, như hiện nay).
5. **Tương thích Save Draft / User Defaults**:
   - Xem trước chỉ là state giao diện, không ghi vào draft hay defaults.
   - "Chọn template này" ở trang Tạo video gọi đúng `update({ templateId })` hiện có, nên autosave và "Lưu làm mặc định" hoạt động như cũ.
   - Template được khôi phục từ draft/defaults mà không còn thì vẫn bị bỏ chọn kèm cảnh báo (VE2E-124).
6. i18n vi / en / ja / ko.

## 4. File dự kiến thay đổi

- Mới: `TemplatePreviewModal.tsx` (+ test); `template-preview.ts` (logic thuần: chọn nguồn xem trước, điều hướng trước/sau; + test); nếu chọn phương án 2a: `RecipePreview.tsx` (+ test).
- Sửa: `JobNewPage.tsx`, `TemplateGalleryPage.tsx`, `OrshotStudioPanel.tsx` (tuỳ câu hỏi 1); `i18n/locales.ts` (+ test i18n).
- **Không đổi** backend, DB, provider adapter hay luồng render.

## 5. Rủi ro

- Đổi hành vi "bấm ảnh = chọn" thành "bấm ảnh = xem trước": thêm một bước so với hiện nay, đổi lại tránh chọn nhầm.
- Preview SDK tải iframe của bên thứ ba: chỉ tải khi người dùng bấm tab "Xem chuyển động"; không chạy trên di động thì quay về ảnh.
- Mô phỏng LyOnix (nếu chọn 2a) chỉ là **xấp xỉ** (không có FFmpeg, chuyển cảnh hay đo font thật), và được ghi rõ "Mô phỏng" trên khung.
- Ảnh provider có thể hết hạn hoặc lỗi: có fallback.

## 6. Câu hỏi cho chủ dự án

1. **Phạm vi màn hình:** (a) cả 3 nơi chọn template (Tạo video, Thư viện template, panel Orshot). Đề xuất: (a). (b) Chỉ trang Tạo video.
2. **Template LyOnix (chưa có ảnh):**
   - (a) **Mô phỏng ngay trong trình duyệt** từ chính recipe: ảnh nền mẫu, dải tiêu đề, phụ đề mẫu 2 dòng, hiệu ứng zoom ảnh, có nhãn "Mô phỏng". Đề xuất: không tốn gì, tự cập nhật khi recipe đổi.
   - (b) **Render sẵn video mẫu** một lần bằng engine thật (FFmpeg trên máy local), lưu file tĩnh nhỏ. Chính xác nhất, nhưng phải render lại mỗi khi recipe đổi.
   - (c) Chỉ hiện mô tả chữ.
3. **Xem chuyển động cho Creatomate bằng Preview SDK:** (a) Có, là tab tuỳ chọn, chỉ khi đã cấu hình public token và người dùng bấm. Đề xuất: có. (b) Không, chỉ ảnh.

## 7. Nghiệm thu (dự kiến)

1. Mỗi template có nút Xem trước; khung 9:16 mở ra với đúng nội dung theo engine.
2. Mở, đóng hay chuyển qua lại giữa các template trong khung xem trước **không** đổi template đang chọn, không ghim snapshot, không gọi render (test khẳng định không có request render/pin).
3. "Chọn template này" áp dụng đúng template; trang Tạo video autosave bản nháp như cũ.
4. Ảnh lỗi thì hiện fallback; có trạng thái đang tải.
5. Draft/defaults: khôi phục và "Lưu làm mặc định" vẫn đúng với template chọn qua khung xem trước.
6. Lint, typecheck, test toàn repo và build web đều pass.

## 8. Kết quả triển khai (2026-10-05)

### 8.1 File

| File | Nội dung |
|---|---|
| `apps/web/src/studio/template-preview.ts` (+ test) | Logic thuần: `templatePreviewSource` (LyOnix → recipe, Creatomate/Orshot → ảnh, không có gì → fallback), `recipeFromExternalId` (`recipe:<id>@<version>`), `canShowMotionPreview` (chỉ Creatomate, cần public token và trình duyệt hỗ trợ), `stepIndex` (trước/sau, quay vòng) |
| `apps/web/src/components/TemplatePreviewModal.tsx` (+ test) | Khung 9:16 dùng chung: tab Ảnh / Xem chuyển động, skeleton khi tải, fallback khi lỗi hoặc không có ảnh, Esc / ← / →, nhãn engine, "Chọn template này" hoặc "Đang dùng template này". Kèm `TemplatePreviewButton` và `TemplateThumb` cho thẻ |
| `apps/web/src/components/RecipePreview.tsx` | Mô phỏng template LyOnix bằng SVG 1080×1920: nền mẫu có zoom chậm, tint, dải khung, hộp/tiêu đề của recipe, phụ đề mẫu tối đa 2 dòng. Tiêu đề và phụ đề dùng **cùng hàm ngắt dòng với engine** (`buildCaptionAss`, giống `media-worker/compose/overlays.ts`), nên co chữ và xuống dòng khớp video thật thay vì bị cắt |
| `apps/web/src/studio/creatomate-preview.ts` | Thêm `loadTemplate(templateId)` cho tab Xem chuyển động |
| `JobNewPage.tsx`, `TemplateGalleryPage.tsx`, `OrshotStudioPanel.tsx` | Bấm ảnh mở xem trước (không chọn); mỗi thẻ có nút **Xem trước** và **Chọn**. Trang Tạo video: chọn gọi `update({ templateId })` như cũ. Thư viện / Orshot: chỉ ghim snapshot khi bấm Chọn; panel Orshot chỉ đóng khung khi ghim thành công |
| `styles.css` | Animation `lyx-recipe-zoom`, skeleton `lyx-skeleton`, tôn trọng `prefers-reduced-motion` |
| `i18n/locales.ts` | 20 khoá `templates.preview*` / `templates.choose` cho vi / en / ja / ko |

Không đổi backend, DB, provider adapter hay luồng render.

### 8.2 Đối chiếu nghiệm thu (mục 7)

1. Có nút Xem trước ở cả 3 màn hình; khung 9:16 hiển thị đúng nguồn theo engine (test `template-preview.test.ts`, `TemplatePreviewModal.test.tsx`).
2. Render khung xem trước không gọi `onSelect`, không ghim snapshot (test khẳng định). Tab Xem chuyển động chỉ tải iframe Creatomate khi người dùng bấm, và chỉ là bản xem trong trình duyệt, không gọi API render.
3. "Chọn template này" ở trang Tạo video đi qua `update({ templateId })` nên autosave bản nháp như cũ.
4. Có skeleton khi tải; ảnh lỗi hoặc không có ảnh chuyển sang fallback (test khẳng định không có `<img>` vỡ).
5. Xem trước chỉ là state giao diện, không ghi vào draft hay defaults. Khôi phục draft/defaults và "Lưu làm mặc định" giữ nguyên hành vi VE2E-124.
6. Kiểm tra toàn repo:
   - `lint`, `typecheck`, `build`: pass.
   - `test`: web 188/188, api 712 pass (5 skip), domain 289, providers 327/328, media-worker 188/191.
   - 4 test fail là lỗi có sẵn trên Windows, không liên quan task này: `providers/template-lint.test.ts` (spawn `.bin/tsx`) và 3 test `media-worker/parity.test.ts` (đường dẫn `fontfile=C:/…` của drawtext).
7. Đã chụp màn hình (Edge headless) cả 3 recipe LyOnix: tiêu đề hiển thị đủ, phụ đề không quá 2 dòng.

### 8.3 Giới hạn đã biết

- Mô phỏng LyOnix là **xấp xỉ**: ảnh nền mẫu, không có chuyển cảnh, font đo bằng ước lượng của `buildCaptionAss`. Khung luôn có nhãn "Mô phỏng".
- Tab Xem chuyển động cần `CREATOMATE_PREVIEW_PUBLIC_TOKEN` và trình duyệt máy tính; nếu thiếu thì tab bị ẩn và chỉ có ảnh.
