// Cấu hình từ biến môi trường (spec §27).
//
// KHÔNG đọc OPENAI_API_KEY ở bất kỳ đâu. Đó là chốt chặn thứ nhất của
// spec §15/§31; chốt thứ hai là danh sách cho phép trong runner.ts.

import type { StorageConfig } from "@tinyorbit/artifact-storage";

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

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v === "true" || v === "1";
}

export interface Config {
  port: number;
  redisUrl: string;
  queueLimit: number;
  workDir: string;
  codexHome: string;
  codexBinary: string;
  jobTimeoutSeconds: number;
  concurrency: number;
  generatedImageRetentionHours: number;
  otlpEndpoint: string;
  s3: StorageConfig;
}

export function loadConfig(): Config {
  return {
    port: int("PORT", 8080),
    redisUrl: str("REDIS_URL"),
    queueLimit: int("QUEUE_LIMIT", 64),
    workDir: str("WORK_DIR", "/work/jobs"),
    codexHome: str("CODEX_HOME", "/home/codex/.codex"),
    codexBinary: str("CODEX_BINARY", "codex"),
    jobTimeoutSeconds: int("JOB_TIMEOUT_SECONDS", 900),
    // Mặc định 1 (spec §14): một phiên ChatGPT, một tiến trình Codex.
    // Cấu hình được để nâng sau, nhưng KHÔNG nâng mặc định.
    concurrency: int("WORKER_CONCURRENCY", 1),
    // Công cụ sinh ảnh của Codex LUÔN để lại một bản trong
    // $CODEX_HOME/generated_images/, kể cả khi job thành công và ảnh đã
    // lên S3 — tức thư mục này phình vô hạn trên PVC. Đo 2026-09-12:
    // 9 file / 5.9MB sau một buổi thử, ~0.7MB mỗi job.
    // Giữ lại một cửa sổ ngắn để còn cứu được ảnh (salvageGeneratedImage)
    // và còn soi được khi có sự cố, quá hạn thì dọn.
    generatedImageRetentionHours: int("GENERATED_IMAGE_RETENTION_HOURS", 24),
    otlpEndpoint: str("OTEL_EXPORTER_OTLP_ENDPOINT", ""),
    s3: {
      endpoint: str("S3_ENDPOINT"),
      bucket: str("S3_BUCKET"),
      region: str("S3_REGION", "us-east-1"),
      // Mặc định TRUE chứ không FALSE: endpoint của cụm này là Ceph RGW
      // sau một Gateway không có listener wildcard, nên
      // virtual-hosted-style hỏng. Mặc định sai ở đây sinh ra lỗi DNS
      // khó đoán chứ không phải lỗi S3 rõ ràng.
      forcePathStyle: bool("S3_FORCE_PATH_STYLE", true),
      publicBaseUrl: str("S3_PUBLIC_BASE_URL").replace(/\/+$/, ""),
      signedUrlTtlSeconds: int("S3_SIGNED_URL_TTL_SECONDS", 86400),
      accessKeyId: str("AWS_ACCESS_KEY_ID", ""),
      secretAccessKey: str("AWS_SECRET_ACCESS_KEY", ""),
    },
  };
}
