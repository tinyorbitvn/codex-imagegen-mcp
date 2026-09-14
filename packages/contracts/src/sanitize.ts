// Làm sạch mọi chuỗi do người dùng cung cấp TRƯỚC khi nó chạm tới hệ
// thống file hoặc dòng lệnh.
//
// Nguyên tắc: DANH SÁCH CHO PHÉP, không phải danh sách cấm. Cấm "../"
// rồi lọc dần là cuộc đua không bao giờ thắng (`....//`, `%2e%2e%2f`,
// ký tự unicode trông giống dấu chấm...). Ở đây chỉ chấp nhận đúng một
// tập ký tự và từ chối phần còn lại.

import { ImagegenError } from "./errors.ts";

/**
 * Định danh an toàn cho `project` và `asset_id`.
 *
 * Cho phép: chữ thường a-z, số, gạch ngang, gạch dưới.
 * Phải bắt đầu và kết thúc bằng chữ hoặc số.
 * Dài 1..64 ký tự.
 *
 * Hệ quả: KHÔNG có dấu chấm, KHÔNG có dấu gạch chéo, KHÔNG có null byte,
 * KHÔNG có khoảng trắng. Nghĩa là không tồn tại chuỗi hợp lệ nào thoát
 * ra khỏi thư mục cha, và không tồn tại chuỗi hợp lệ nào được shell diễn
 * giải thành cú pháp.
 */
const SAFE_ID = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;

export function sanitizeIdentifier(
  value: unknown,
  field: "project" | "asset_id" | "artifact_id",
): string {
  if (typeof value !== "string") {
    throw new ImagegenError(
      field === "project" ? "INVALID_PROJECT" : "INVALID_ASSET_ID",
      `${field} phải là chuỗi`,
    );
  }

  // Chuẩn hoá NFKC TRƯỚC khi kiểm. Không có bước này thì ký tự dựng sẵn
  // trông y hệt ASCII vẫn lọt qua regex ở dạng khác.
  const normalized = value.normalize("NFKC").trim().toLowerCase();

  if (!SAFE_ID.test(normalized)) {
    throw new ImagegenError(
      field === "project" ? "INVALID_PROJECT" : "INVALID_ASSET_ID",
      `${field} chỉ được chứa a-z, 0-9, "-", "_", dài 1..64, ` +
        `bắt đầu và kết thúc bằng chữ hoặc số`,
    );
  }

  return normalized;
}

/**
 * Tên file đầu ra do người dùng đặt (tuỳ chọn).
 *
 * Chỉ lấy phần basename và ép qua cùng bộ lọc như định danh, rồi TỰ gắn
 * đuôi theo `format` — KHÔNG bao giờ tin đuôi file người dùng gửi lên.
 * Nhờ vậy không có đường nào tạo ra ".." hay "/etc/passwd" hay
 * "x.webp.sh".
 */
export function sanitizeFilename(
  value: string | undefined,
  format: "png" | "webp",
  fallback: string,
): string {
  if (value === undefined || value === "") {
    return `${fallback}.${format}`;
  }

  const base = value
    .normalize("NFKC")
    .split(/[/\\]/)
    .pop()!
    .replace(/\.[A-Za-z0-9]+$/, "")
    .trim()
    .toLowerCase();

  if (!SAFE_ID.test(base)) {
    throw new ImagegenError(
      "UNSUPPORTED_FORMAT",
      "output.filename chỉ được chứa a-z, 0-9, \"-\", \"_\"",
    );
  }

  return `${base}.${format}`;
}

/**
 * Văn bản tự do đi vào prompt Codex (description, style.prompt,
 * instructions).
 *
 * Ở đây KHÔNG lọc theo danh sách ký tự — làm thế sẽ phá tiếng Việt có
 * dấu và mọi mô tả có ý nghĩa. Thay vào đó:
 *
 *   1. Bỏ ký tự điều khiển (kể cả NUL) — chúng không mang nghĩa trong mô
 *      tả ảnh và là nguyên liệu cho đủ loại trò chèn.
 *   2. Chặn độ dài, để một mô tả khổng lồ không thổi bay bộ nhớ hay bị
 *      dùng làm đòn bẩy nhồi prompt.
 *
 * AN TOÀN LỆNH KHÔNG DỰA VÀO HÀM NÀY. Prompt được truyền cho Codex như
 * MỘT PHẦN TỬ trong mảng argv (xem codex/runner.ts), không bao giờ nối
 * vào chuỗi shell. Kể cả khi chuỗi chứa "; rm -rf /" thì nó vẫn chỉ là
 * một tham số, không phải cú pháp. Hàm này là lớp phòng thủ thứ hai.
 */
export function sanitizeFreeText(
  value: unknown,
  field: string,
  maxLength = 4000,
): string {
  if (typeof value !== "string") {
    throw new ImagegenError("IMAGE_GENERATION_FAILED", `${field} phải là chuỗi`);
  }

  // Character class dưới đây CỐ Ý chứa ký tự điều khiển (viết dưới
  // dạng escape để file vẫn là văn bản thuần — bản trước lỡ ghi byte
  // thô khiến git coi file là binary).
  const cleaned = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .trim();

  if (cleaned.length === 0) {
    throw new ImagegenError("IMAGE_GENERATION_FAILED", `${field} không được rỗng`);
  }

  if (cleaned.length > maxLength) {
    throw new ImagegenError(
      "IMAGE_GENERATION_FAILED",
      `${field} dài quá ${maxLength} ký tự`,
    );
  }

  return cleaned;
}

/**
 * Khoá S3 của một artifact. Ghép TỪ các mảnh đã làm sạch, không bao giờ
 * ghép từ chuỗi thô.
 *
 * Bố cục theo spec §22:
 *   projects/<project>/<artifact_id>/v<version>/<filename>
 */
export function artifactKey(
  project: string,
  artifactId: string,
  version: number,
  filename: string,
): string {
  if (!Number.isInteger(version) || version < 1) {
    throw new ImagegenError("IMAGE_GENERATION_FAILED", "version phải là số nguyên >= 1");
  }
  return `projects/${project}/${artifactId}/v${version}/${filename}`;
}
