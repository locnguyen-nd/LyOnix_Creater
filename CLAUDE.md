Tài liệu nghiệp vụ và pipeline nằm trong root của repository hiện tại:

- pipeline/state.json
- .docs/specs/

Trước khi nhận task:
1. Đọc pipeline/state.json.
2. Chỉ code task có status: ready.
3. Đọc spec tương ứng trong .docs/specs/.
4. Khi bắt đầu, chuyển status sang in_progress.
5. Khi code + test xong, chuyển sang code_done.
6. Không tự chuyển done; quyền xác nhận done thuộc chủ dự án.
7. Task bị task khác thay thế dùng status superseded.