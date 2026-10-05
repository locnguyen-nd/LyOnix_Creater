import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConfirmDialog, type ConfirmDialogProps } from "./ConfirmDialog";

const props = (overrides: Partial<ConfirmDialogProps> = {}): ConfirmDialogProps => ({
  open: true,
  title: "Xoá bản nháp đang làm dở?",
  message: "Bản nháp sẽ bị xoá vĩnh viễn và không thể khôi phục.",
  details: ["Nội dung đã nhập", "Các lựa chọn hiện tại"],
  note: "Tuỳ chọn mặc định của bạn vẫn được giữ nguyên.",
  confirmLabel: "Xoá bản nháp",
  cancelLabel: "Hủy",
  busyLabel: "Đang xoá…",
  onConfirm: () => undefined,
  onCancel: () => undefined,
  ...overrides,
});

describe("ConfirmDialog (VE2E-124)", () => {
  it("renders nothing while closed", () => {
    expect(renderToStaticMarkup(<ConfirmDialog {...props({ open: false })} />)).toBe("");
  });

  it("is an accessible alert dialog with the consequences listed, a red confirm button and the entrance animation", () => {
    const out = renderToStaticMarkup(<ConfirmDialog {...props()} />);
    expect(out).toContain('role="alertdialog"');
    expect(out).toContain('aria-modal="true"');
    expect(out).toMatch(/aria-labelledby="[^"]+"/);
    expect(out).toContain("Xoá bản nháp đang làm dở?");
    expect(out).toContain("Nội dung đã nhập");
    expect(out).toContain("Tuỳ chọn mặc định của bạn vẫn được giữ nguyên.");
    expect(out).toContain("lyx-btn-danger-solid");
    expect(out).toContain("lyx-anim-dialog");
    expect(out).toContain("lyx-anim-danger-icon");
  });

  it("shows the busy label and locks both buttons while the action runs", () => {
    const out = renderToStaticMarkup(<ConfirmDialog {...props({ busy: true })} />);
    expect(out).toContain("Đang xoá…");
    expect((out.match(/<button[^>]*disabled=""/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});
