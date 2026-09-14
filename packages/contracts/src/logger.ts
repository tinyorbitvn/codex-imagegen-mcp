// Log JSON có cấu trúc (spec §22).
//
// *** DANH SÁCH CẤM TUYỆT ĐỐI TRONG LOG ***
//   access/refresh token ChatGPT, token Keycloak, client secret,
//   key S3, header Authorization đầy đủ.
//
// Cách thực thi KHÔNG phải "nhớ đừng log": mọi giá trị đi qua `redact()`
// trước khi serialize, và các khoá nghi ngờ bị thay bằng "[redacted]"
// theo TÊN KHOÁ. Lập trình viên sau có lỡ nhét cả object cấu hình vào
// log thì secret vẫn không ra ngoài.

const SECRET_KEY_PATTERN =
  /(secret|token|password|passwd|credential|authorization|api[_-]?key|access[_-]?key|private)/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[too-deep]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_PATTERN.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

/**
 * Tên service gắn vào mọi dòng log.
 *
 * KHÔNG hardcode: gói này dùng chung cho imagegen-mcp và
 * codex-image-worker, và một tên cố định sẽ khiến log của hai pod trộn
 * vào nhau không phân biệt được — đúng lúc đang cần lần một job đi qua
 * cả hai.
 *
 * Lấy từ OTEL_SERVICE_NAME để trùng với tên hiện trong trace, nhờ vậy
 * nhảy giữa log và trace trong Grafana không phải dịch tên.
 */
let serviceName = process.env.OTEL_SERVICE_NAME || "tinyorbit-mcp";

/** Đặt tên service lúc khởi động, trước khi ghi dòng log đầu tiên. */
export function setServiceName(name: string): void {
  serviceName = name;
}

type Level = "debug" | "info" | "warn" | "error";

function emit(level: Level, message: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    service: serviceName,
    message,
    ...(redact(fields) as Record<string, unknown>),
  });
  // stderr cho warn/error để tách khỏi luồng chính khi gom log.
  if (level === "error" || level === "warn") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export const log = {
  debug: (m: string, f?: Record<string, unknown>) => emit("debug", m, f),
  info: (m: string, f?: Record<string, unknown>) => emit("info", m, f),
  warn: (m: string, f?: Record<string, unknown>) => emit("warn", m, f),
  error: (m: string, f?: Record<string, unknown>) => emit("error", m, f),
};
