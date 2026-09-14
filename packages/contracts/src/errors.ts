// Mã lỗi theo spec §36.
//
// Thông điệp trả ra ngoài phải AN TOÀN VÀ HÀNH ĐỘNG ĐƯỢC: nói người gọi
// cần làm gì, KHÔNG kèm credential, KHÔNG dump biến môi trường, KHÔNG
// kèm stderr thô của tiến trình con (stderr của Codex có thể chứa đường
// dẫn token hoặc mẩu header xác thực).

export const ERROR_CODES = [
  "CODEX_NOT_AUTHENTICATED",
  "CODEX_NOT_AVAILABLE",
  // Tài khoản/phiên ChatGPT đăng nhập được nhưng KHÔNG có khả năng sinh
  // ảnh. Spec §31 đòi báo lỗi khả năng tường minh thay vì im lặng rơi
  // về OPENAI_API_KEY — mã riêng để vận hành phân biệt được "chưa đăng
  // nhập" với "đăng nhập rồi nhưng gói không hỗ trợ".
  "IMAGE_CAPABILITY_UNAVAILABLE",
  "IMAGE_GENERATION_FAILED",
  "JOB_NOT_FOUND",
  "JOB_CANCELLED",
  "STORAGE_UPLOAD_FAILED",
  "INVALID_ASSET_ID",
  "INVALID_PROJECT",
  "UNSUPPORTED_FORMAT",
  "UNKNOWN_STYLE_PROFILE",
  "RATE_LIMITED",
  "UNAUTHORIZED",
  "FORBIDDEN",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class ImagegenError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "ImagegenError";
    this.code = code;
  }

  /** Dạng đưa vào structuredContent của MCP. */
  toJSON(): { error: { code: ErrorCode; message: string } } {
    return { error: { code: this.code, message: this.message } };
  }
}

/**
 * Biến lỗi bất kỳ thành ImagegenError.
 *
 * Lỗi KHÔNG phải ImagegenError (bug, lỗi mạng, lỗi SDK) bị nuốt thông
 * điệp gốc CÓ CHỦ ĐÍCH: message của chúng hay kèm URL đầy đủ, header,
 * hoặc đường dẫn nội bộ. Chi tiết thật vẫn được ghi log phía server
 * (đã lọc) để vận hành lần ra, nhưng không đi ra ngoài qua MCP.
 */
export function toImagegenError(err: unknown, fallback: ErrorCode): ImagegenError {
  if (err instanceof ImagegenError) return err;
  return new ImagegenError(
    fallback,
    "Thao tác thất bại. Xem log của service theo job_id để biết chi tiết.",
  );
}
