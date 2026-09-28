# Maintain Verification Skills — Wayfinding Map

## Destination

Tạo một engineering specification được PO phê duyệt cho agent-neutral
maintenance skill có thể phát hiện Artwork behavior drift, cập nhật verifier và
FE host đúng boundary, chứng minh kết quả, rồi commit/push hai private
repositories theo một recoverable transaction.

## Notes

- Project Home: [PROJECT.md](../PROJECT.md)
- FE checkout là prerequisite; không clone FE.
- Không phụ thuộc Pi hoặc một agent host cụ thể.
- Official repositories luôn read-only.
- Unsupported/ambiguous behavior phải tạo verification gap.
- Wayfinding giải quyết decisions; chưa triển khai maintenance skill trong map.

## Decisions so far

- FE checkout tồn tại trước invocation; installer không sở hữu repository clone.
- Canonical workflow là agent-neutral; Pi-specific installation/projection
  requirements bị loại khỏi destination.
- Test-case intake phải hỗ trợ local file, URL, inline JSON và natural language.
- Autonomous maintenance được tách thành project riêng thay vì ghép vào runtime
  verify skill.

## Not yet specified

- Mức tự động hóa hợp lệ cho việc author Oracle/expectation mới.
- Khi nào source delta đủ nhỏ để auto-maintain và khi nào phải yêu cầu human
  approval.
- Independent authority nào ngăn verifier update tự xác nhận chính nó.
- Policy cho feature removal, rename, split/merge và changed semantics.
- Cách version/migrate durable evidence contracts khi schema thay đổi.
- Phạm vi support ngoài desktop Chromium sau khi maintenance workflow ổn định.

## Out of scope

- Product discovery và lựa chọn feature.
- Sửa product regression để test PASS.
- Official upstream write/push.
- Deployment, Release Credit và production-safety claims.
