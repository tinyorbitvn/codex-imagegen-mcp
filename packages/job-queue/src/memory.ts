// Cài đặt JobStore + JobQueue trong bộ nhớ.
//
// Hai công dụng, cả hai đều thật:
//   1. Test hợp đồng MCP và vòng đời job mà không cần dựng Redis
//      (spec §29 Phase 2 nói thẳng là nên làm vậy trước khi đụng Codex).
//   2. Chạy thử cục bộ một service.
//
// TUYỆT ĐỐI KHÔNG dùng cho production: dữ liệu mất khi tiến trình chết,
// và không chia sẻ được giữa các replica — vi phạm thẳng spec §30 về
// tính bền của metadata artifact. Chart không bao giờ chọn cài đặt này.
//
// Sự tồn tại của file này cũng là bằng chứng lớp trừu tượng ở types.ts
// là thật chứ không phải trang trí: có đúng hai cài đặt độc lập.

import { ImagegenError } from "@tinyorbit/contracts";
import type { ArtifactRef, JobPayload, JobRecord } from "@tinyorbit/contracts";
import type { JobQueue, JobStore } from "./types.ts";

export class InMemoryJobStore implements JobStore {
  #jobs = new Map<string, JobRecord>();

  async create(job: JobRecord): Promise<void> {
    this.#jobs.set(job.jobId, { ...job });
  }

  async get(jobId: string): Promise<JobRecord | null> {
    const j = this.#jobs.get(jobId);
    return j ? { ...j } : null;
  }

  async markRunning(jobId: string): Promise<void> {
    const j = this.#jobs.get(jobId);
    if (j?.status === "queued") {
      j.status = "running";
      j.startedAt = new Date().toISOString();
    }
  }

  async markCompleted(jobId: string, artifact: ArtifactRef): Promise<void> {
    const j = this.#jobs.get(jobId);
    if (!j) return;
    j.status = "completed";
    j.completedAt = new Date().toISOString();
    j.artifact = artifact;
  }

  async markFailed(jobId: string, code: string, message: string): Promise<void> {
    const j = this.#jobs.get(jobId);
    // Job đã ở trạng thái cuối thì KHÔNG ghi đè — giống hệt bản Redis.
    if (!j || j.status === "completed" || j.status === "cancelled") return;
    j.status = "failed";
    j.completedAt = new Date().toISOString();
    j.errorCode = code;
    j.errorMessage = message;
  }

  async markCancelled(jobId: string): Promise<boolean> {
    const j = this.#jobs.get(jobId);
    if (!j || (j.status !== "queued" && j.status !== "running")) return false;
    j.status = "cancelled";
    j.completedAt = new Date().toISOString();
    return true;
  }

  async highestAllocatedVersion(projectId: string, assetId: string): Promise<number> {
    let max = 0;
    for (const j of this.#jobs.values()) {
      if (j.projectId === projectId && j.assetId === assetId && j.status !== "failed") {
        max = Math.max(max, j.version);
      }
    }
    return max;
  }

  async getArtifact(
    projectId: string,
    assetId: string,
    version?: number,
  ): Promise<JobRecord | null> {
    const done = [...this.#jobs.values()].filter(
      (j) => j.projectId === projectId && j.assetId === assetId && j.status === "completed",
    );
    if (done.length === 0) return null;
    if (version === undefined) {
      done.sort((a, b) => b.version - a.version);
      return { ...done[0]! };
    }
    const hit = done.find((j) => j.version === version);
    return hit ? { ...hit } : null;
  }

  async countSince(principal: string, sinceMs: number): Promise<number> {
    let n = 0;
    for (const j of this.#jobs.values()) {
      if (j.principal === principal && Date.parse(j.createdAt) >= sinceMs) n += 1;
    }
    return n;
  }

  async close(): Promise<void> {
    this.#jobs.clear();
  }
}

export class InMemoryJobQueue implements JobQueue {
  #pending: JobPayload[] = [];
  #processing = new Map<string, JobPayload>();
  #cancelled = new Set<string>();
  #limit: number;

  constructor(limit = 64) {
    this.#limit = limit;
  }

  async enqueue(payload: JobPayload): Promise<void> {
    if (this.#pending.length >= this.#limit) {
      throw new ImagegenError(
        "RATE_LIMITED",
        `Hàng đợi đã đầy (${this.#limit} việc đang chờ). Thử lại sau.`,
      );
    }
    this.#pending.push(payload);
  }

  async dequeue(timeoutMs: number): Promise<JobPayload | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const next = this.#pending.shift();
      if (next) {
        this.#processing.set(next.jobId, next);
        return next;
      }
      if (Date.now() >= deadline) return null;
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  async ack(jobId: string): Promise<void> {
    this.#processing.delete(jobId);
  }

  async reapStale(): Promise<JobPayload[]> {
    const out = [...this.#processing.values()];
    this.#processing.clear();
    return out;
  }

  async requestCancel(jobId: string): Promise<void> {
    this.#cancelled.add(jobId);
  }

  async isCancelled(jobId: string): Promise<boolean> {
    return this.#cancelled.has(jobId);
  }

  async depth(): Promise<number> {
    return this.#pending.length;
  }

  async close(): Promise<void> {
    this.#pending = [];
    this.#processing.clear();
  }
}
