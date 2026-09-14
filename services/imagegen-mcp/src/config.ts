// Cấu hình từ biến môi trường, do Helm chart bơm vào (spec §27).
//
// KHÔNG có giá trị nào trỏ tới OpenAI API key. Service này thậm chí
// không chạm tới Codex — nó chỉ đẩy việc vào hàng đợi.

function str(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Thiếu biến môi trường bắt buộc: ${name}`);
  }
  return v;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`${name} phải là số nguyên, nhận: ${v}`);
  return n;
}

export interface Config {
  port: number;
  redisUrl: string;
  queueLimit: number;
  otlpEndpoint: string;
  rateLimit: { createImagePerHour: number; editImagePerHour: number };
}

export function loadConfig(): Config {
  return {
    port: int("PORT", 8080),
    redisUrl: str("REDIS_URL"),
    queueLimit: int("QUEUE_LIMIT", 64),
    // Rỗng = tắt hẳn OTLP. Cụm này đã có alloy-traces nên chart trỏ sẵn
    // vào đó thay vì dựng collector mới (spec §22).
    otlpEndpoint: str("OTEL_EXPORTER_OTLP_ENDPOINT", ""),
    rateLimit: {
      createImagePerHour: int("RATE_LIMIT_CREATE_IMAGE_PER_HOUR", 10),
      editImagePerHour: int("RATE_LIMIT_EDIT_IMAGE_PER_HOUR", 20),
    },
  };
}
