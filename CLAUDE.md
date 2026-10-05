# LyOnix Creater — monorepo (code)
# Trước khi nhận task:
1. Đọc pipeline/state.json.
2. Chỉ code task có status: ready.
3. Đọc spec tương ứng trong .docs/specs/.
4. Khi bắt đầu, chuyển status sang in_progress.
5. Khi code + test xong, chuyển sang code_done.
6. Không tự chuyển done; quyền xác nhận done thuộc chủ dự án.
7. Task bị task khác thay thế dùng status superseded.
Tài liệu nghiệp vụ/pipeline ở repo cha `D:\LyOnix` (xem `../../CLAUDE.md`, `../../.docs/`,
`../../pipeline/`). File này chỉ nói về code trong `SourceCode/LyOnix_Creater/`.

## Layout

- `apps/web` — React/Vite Studio (UI, i18n vi/en/ja/ko)
- `apps/api` — NestJS REST API + OpenAPI
- `apps/worker` — workflow worker (outbox/inbox, lease)
- `apps/media-worker` — **duy nhất nơi chạy FFmpeg**; không FFmpeg trong request HTTP
- `packages/contracts` — REST types + OpenAPI 3.1 base, dùng chung web/api
- `packages/db` — Prisma schema/client, PostgreSQL
- `packages/domain` — domain logic thuần, không phụ thuộc framework
- `packages/providers` — adapter ports cho content/render/account provider (OpenAI/Gemini/xAI/ElevenLabs/Pexels/Creatomate); không tích hợp Vrew.
- `packages/observability` — logging/tracing chung
- `infra/compose` — PostgreSQL + RabbitMQ local

Node 24+, Corepack/pnpm bắt buộc. Không dùng npm/yarn.

## Lệnh

```powershell
corepack pnpm install
corepack pnpm typecheck
corepack pnpm test
corepack pnpm lint
corepack pnpm build
corepack pnpm --filter @lyonix/web dev   # http://localhost:5173
corepack pnpm dev                         # api + web song song
```

Local demo accounts (không phải secret production): `admin@lyonix.local` / `lyonix-admin`,
`staff@lyonix.local` / `lyonix-staff`.

## Quy ước

- Provider luôn qua interface trong `packages/providers`; fake/mock provider chỉ dùng trong test,
  runtime phải fail-fast (`PROVIDER_NOT_CONFIGURED`) khi thiếu secret, không fallback fake ngầm.
- 2 role duy nhất: `admin|staff`. Không thêm role khác khi chưa có CR.
- File tạm/derivative có TTL 7 ngày (không áp dụng cho project asset tái sử dụng — xem spec V05).
- Không thêm dependency S3/MinIO. Không thêm export CapCut.
- Test đơn vị cho logic thay đổi; không gọi provider trả phí thật trong CI/test process (dùng HTTP stub local).
- Windows: Prisma generate có thể vướng khóa DLL query-engine cục bộ — biết vấn đề này trước khi báo lỗi mới.

## Trước khi sửa code

Đọc task tương ứng trong `../../pipeline/state.json`, chỉ nhận task `status: ready`, và spec khớp
trong `../../.docs/specs/`. Xong việc: cập nhật state thành `code_done` + note file đã đụng, không tự
tick `done`. Chi tiết đầy đủ: `../../.agent/code.md` hoặc gọi `/lyonix-code` trong Claude Code.

## Quản lý branch và commit

Tuân thủ quy tắc dùng chung tại `../../.agent/README.md`: bắt đầu feature/fix branch từ `origin/dev` mới
nhất; tích hợp chức năng vào `dev` qua PR; chỉ đưa `dev` vào `main` cho release đã duyệt. Tách commit theo
nhóm chức năng, không làm trực tiếp trên `dev`/`main`, không force-push/rewrite lịch sử nhánh dùng chung,
không commit secret. Nếu không xác nhận được `origin/dev`, dừng tích hợp và báo chủ dự án.

**Không attribution Claude (chủ dự án chốt 02/10/2026):** không thêm `Co-Authored-By: Claude ... <noreply@anthropic.com>`,
logo hay dòng "Generated with Claude Code" vào commit/PR. Quy định này ghi đè mặc định của công cụ; đã khóa bằng
`.claude/settings.json` (`attribution.commit`/`attribution.pr` rỗng).
