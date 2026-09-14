// Mô hình job dùng CHUNG giữa imagegen-mcp và codex-image-worker.
//
// Đây là lý do gói `contracts` tồn tại: hai service chạy ở hai pod khác
// nhau nhưng phải hiểu y hệt nhau về hình dạng một job. Định nghĩa hai
// lần là sớm muộn cũng lệch — và lệch sẽ hiện ra dưới dạng job im lặng
// hỏng, không phải lỗi biên dịch.

import type { AspectRatio, OutputFormat } from "./schemas.ts";

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

/** Trạng thái cuối — job đã ở đây thì không bao giờ đổi nữa. */
export const TERMINAL_STATUSES: readonly JobStatus[] = [
  "completed",
  "failed",
  "cancelled",
];

export function isTerminal(s: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(s);
}

/**
 * Đặc tả ảnh đã CHUẨN HOÁ.
 *
 * imagegen-mcp nhận đầu vào thô từ MCP, làm sạch và điền mặc định rồi
 * mới tạo ra cấu trúc này. Worker KHÔNG bao giờ thấy chuỗi thô của
 * người dùng ngoài ba trường văn bản đã lọc bên dưới — nhờ vậy phần
 * dựng lệnh Codex chỉ phải tin một nguồn duy nhất.
 */
export interface ImageSpec {
  projectId: string;
  assetId: string;
  description: string;
  /** Đã gộp: style profile (nếu có) + prompt thêm của người gọi. */
  stylePrompt: string;
  /** Tên style profile đã dùng, để ghi vào metadata. */
  styleReference: string | null;
  aspectRatio: AspectRatio;
  width: number;
  height: number;
  transparentBackground: boolean;
  outputFormat: OutputFormat;
  isolatedObject: boolean;
  safePaddingPercent: number;
  /** Tên file đầu ra trong thư mục job. Do worker đặt, không phải người dùng. */
  filename: string;
}

/** Việc mà worker phải làm. */
export interface JobPayload {
  jobId: string;
  kind: "create" | "edit";
  spec: ImageSpec;
  version: number;
  /** Chỉ có với kind="edit". */
  parentVersion: number | null;
  /** Khoá S3 của ảnh nguồn, chỉ có với kind="edit". */
  sourceKey: string | null;
  /** Chỉ có với kind="edit": chỉ dẫn sửa, đã lọc. */
  instructions: string | null;
}

export interface ArtifactRef {
  projectId: string;
  assetId: string;
  version: number;
  parentVersion: number | null;
  key: string;
  url: string;
  mimeType: string;
  width: number;
  height: number;
  transparent: boolean;
  specHash: string;
  createdAt: string;
}

export interface JobRecord {
  jobId: string;
  status: JobStatus;
  projectId: string;
  assetId: string;
  version: number;
  parentVersion: number | null;
  /** Chủ thể gọi, lấy từ claim JWT mà agentgateway chuyển xuống. */
  principal: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  artifact: ArtifactRef | null;
  errorCode: string | null;
  errorMessage: string | null;
  /** trace_id của OpenTelemetry, để nối log job với trace gateway. */
  traceId: string | null;
}

export const MIME_BY_FORMAT: Record<OutputFormat, string> = {
  png: "image/png",
  webp: "image/webp",
};

/** Hình dạng trả về cho MCP client (spec §11, §12). */
export function jobToResult(job: JobRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {
    job_id: job.jobId,
    status: job.status,
  };

  if (job.status === "completed" && job.artifact) {
    const a = job.artifact;
    out.artifact = {
      project_id: a.projectId,
      asset_id: a.assetId,
      version: a.version,
      parent_version: a.parentVersion,
      url: a.url,
      mime_type: a.mimeType,
      width: a.width,
      height: a.height,
      transparent: a.transparent,
      created_at: a.createdAt,
    };
  }

  if (job.status === "failed") {
    out.error = { code: job.errorCode, message: job.errorMessage };
  }

  return out;
}
