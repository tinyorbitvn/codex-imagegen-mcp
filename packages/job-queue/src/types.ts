// Trừu tượng hàng đợi + kho trạng thái job.
//
// *** VÌ SAO CÓ LỚP TRỪU TƯỢNG NÀY (spec §13) ***
// Redis là lựa chọn hiện tại, không phải lựa chọn vĩnh viễn. Hai
// interface dưới đây là toàn bộ thứ mà imagegen-mcp và
// codex-image-worker được phép biết; đổi sang Postgres/NATS/SQS sau này
// chỉ phải viết một lớp cài đặt mới, không đụng vào nghiệp vụ.
//
// Đây KHÔNG phải trừu tượng hoá sớm vô cớ: spec nói rõ "Keep the
// implementation abstract enough that Redis is replaceable later", và
// chi phí ở đây đúng bằng hai interface.

import type { JobPayload, JobRecord, JobStatus, ArtifactRef } from "@tinyorbit/contracts";

/**
 * Kho trạng thái job. PHẢI bền qua restart (spec §30): khởi động lại
 * imagegen-mcp / worker / gateway không được làm mất metadata artifact
 * của job đã hoàn tất.
 */
export interface JobStore {
  create(job: JobRecord): Promise<void>;
  get(jobId: string): Promise<JobRecord | null>;

  markRunning(jobId: string): Promise<void>;
  markCompleted(jobId: string, artifact: ArtifactRef): Promise<void>;
  markFailed(jobId: string, code: string, message: string): Promise<void>;
  /** Trả false nếu job đã ở trạng thái cuối (không huỷ ngược được). */
  markCancelled(jobId: string): Promise<boolean>;

  /**
   * Phiên bản cao nhất ĐÃ CẤP PHÁT cho một artifact, kể cả job đang
   * chạy. Cấp số mới phải dựa vào đây chứ KHÔNG phải phiên bản đã hoàn
   * tất — nếu không, hai job song song trên cùng asset cùng nhận một số
   * và job sau ghi đè job trước trên object storage.
   */
  highestAllocatedVersion(projectId: string, assetId: string): Promise<number>;

  /** Bỏ trống `version` = bản hoàn tất mới nhất. */
  getArtifact(
    projectId: string,
    assetId: string,
    version?: number,
  ): Promise<JobRecord | null>;

  /** Đếm job của một chủ thể từ mốc thời gian — phục vụ rate limit. */
  countSince(principal: string, sinceMs: number): Promise<number>;

  close(): Promise<void>;
}

/** Hàng đợi việc giữa imagegen-mcp (producer) và worker (consumer). */
export interface JobQueue {
  /** Đẩy việc vào hàng đợi. Ném RATE_LIMITED khi hàng đợi đã đầy. */
  enqueue(payload: JobPayload): Promise<void>;

  /**
   * Chờ lấy một việc. Trả null khi hết `timeoutMs` mà không có việc —
   * để vòng lặp consumer còn kiểm tín hiệu dừng thay vì chặn vĩnh viễn.
   */
  dequeue(timeoutMs: number): Promise<JobPayload | null>;

  /** Báo job đã xử lý xong để hàng đợi bỏ nó khỏi danh sách đang chạy. */
  ack(jobId: string): Promise<void>;

  /** Đặt cờ huỷ. Worker đọc cờ này giữa các chặng và khi chạy Codex. */
  requestCancel(jobId: string): Promise<void>;
  isCancelled(jobId: string): Promise<boolean>;

  /** Số việc đang chờ — cho metric và cho ngưỡng từ chối. */
  depth(): Promise<number>;

  close(): Promise<void>;
}

export type { JobPayload, JobRecord, JobStatus, ArtifactRef };
