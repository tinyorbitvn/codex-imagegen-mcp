// Cài đặt JobStore + JobQueue trên Redis.
//
// Bố cục khoá:
//   job:<jobId>                 STRING(JSON)  bản ghi job
//   queue:imagegen              LIST          việc đang chờ (FIFO)
//   queue:imagegen:processing   LIST          việc đã lấy, chưa ack
//   cancel:<jobId>              STRING        cờ huỷ
//   artifact:<proj>:<asset>     ZSET          version -> jobId (mọi job chưa fail)
//   done:<proj>:<asset>         ZSET          version -> jobId (chỉ job completed)
//   principal:<name>            ZSET          thời điểm -> jobId (rate limit)
//
// *** VÌ SAO DÙNG BRPOPLPUSH CHỨ KHÔNG PHẢI BRPOP ***
// BRPOP lấy việc ra khỏi hàng đợi là mất dấu: worker chết giữa chừng
// thì việc biến mất và job treo ở "queued" mãi. BRPOPLPUSH chuyển
// nguyên tử sang danh sách `processing`, nên còn dấu vết để dọn.
// `reapStale()` lúc worker khởi động lại đọc danh sách đó.

import { Redis } from "ioredis";
import { ImagegenError } from "@tinyorbit/contracts";
import type { ArtifactRef, JobPayload, JobRecord } from "@tinyorbit/contracts";
import type { JobQueue, JobStore } from "./types.ts";

const QUEUE = "queue:imagegen";
const PROCESSING = "queue:imagegen:processing";

/** Job giữ 30 ngày rồi tự hết hạn — đủ lâu để tra cứu, không phình mãi. */
const JOB_TTL_SECONDS = 30 * 24 * 3600;

export interface RedisOptions {
  url: string;
  /** Trần số việc đang chờ. Vượt thì từ chối NGAY thay vì xếp hàng vô hạn. */
  queueLimit: number;
}

function connect(url: string): Redis {
  return new Redis(url, {
    // Thử lại có trần: Redis chớp nháy thì tự nối lại, nhưng Redis chết
    // hẳn thì lỗi phải nổi lên chứ không treo request MCP vô thời hạn.
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 200, 2000),
    enableReadyCheck: true,
  });
}

export class RedisJobStore implements JobStore {
  #r: Redis;

  constructor(opts: RedisOptions) {
    this.#r = connect(opts.url);
  }

  get client(): Redis {
    return this.#r;
  }

  async create(job: JobRecord): Promise<void> {
    const m = this.#r.multi();
    m.set(`job:${job.jobId}`, JSON.stringify(job), "EX", JOB_TTL_SECONDS);
    // Ghi vào chỉ mục "đã cấp phát" NGAY lúc tạo, trước khi job chạy —
    // đó là điều khiến hai job song song không cùng nhận một version.
    m.zadd(`artifact:${job.projectId}:${job.assetId}`, job.version, job.jobId);
    m.zadd(`principal:${job.principal}`, Date.now(), job.jobId);
    // Dọn mốc rate limit cũ hơn 24h để ZSET không phình vô hạn.
    m.zremrangebyscore(`principal:${job.principal}`, 0, Date.now() - 24 * 3600_000);
    await m.exec();
  }

  async get(jobId: string): Promise<JobRecord | null> {
    const raw = await this.#r.get(`job:${jobId}`);
    return raw ? (JSON.parse(raw) as JobRecord) : null;
  }

  async #update(jobId: string, fn: (j: JobRecord) => JobRecord | null): Promise<boolean> {
    const job = await this.get(jobId);
    if (!job) return false;
    const next = fn(job);
    if (!next) return false;
    await this.#r.set(`job:${jobId}`, JSON.stringify(next), "EX", JOB_TTL_SECONDS);
    return true;
  }

  async markRunning(jobId: string): Promise<void> {
    await this.#update(jobId, (j) =>
      j.status === "queued"
        ? { ...j, status: "running", startedAt: new Date().toISOString() }
        : null,
    );
  }

  async markCompleted(jobId: string, artifact: ArtifactRef): Promise<void> {
    const ok = await this.#update(jobId, (j) => ({
      ...j,
      status: "completed",
      completedAt: new Date().toISOString(),
      artifact,
    }));
    if (ok) {
      await this.#r.zadd(
        `done:${artifact.projectId}:${artifact.assetId}`,
        artifact.version,
        jobId,
      );
    }
  }

  async markFailed(jobId: string, code: string, message: string): Promise<void> {
    await this.#update(jobId, (j) =>
      // Job đã ở trạng thái cuối thì KHÔNG ghi đè: một lượt dọn dẹp muộn
      // không được biến job thành công thành thất bại.
      j.status === "completed" || j.status === "cancelled"
        ? null
        : {
            ...j,
            status: "failed",
            completedAt: new Date().toISOString(),
            errorCode: code,
            errorMessage: message,
          },
    );
    // Trả lại số phiên bản cho lần sau: job hỏng không được chiếm chỗ.
    const job = await this.get(jobId);
    if (job) {
      await this.#r.zrem(`artifact:${job.projectId}:${job.assetId}`, jobId);
    }
  }

  async markCancelled(jobId: string): Promise<boolean> {
    const changed = await this.#update(jobId, (j) =>
      j.status === "queued" || j.status === "running"
        ? { ...j, status: "cancelled", completedAt: new Date().toISOString() }
        : null,
    );
    if (changed) {
      const job = await this.get(jobId);
      if (job) await this.#r.zrem(`artifact:${job.projectId}:${job.assetId}`, jobId);
    }
    return changed;
  }

  async highestAllocatedVersion(projectId: string, assetId: string): Promise<number> {
    const top = await this.#r.zrevrange(`artifact:${projectId}:${assetId}`, 0, 0, "WITHSCORES");
    return top.length >= 2 ? Number(top[1]) : 0;
  }

  async getArtifact(
    projectId: string,
    assetId: string,
    version?: number,
  ): Promise<JobRecord | null> {
    const key = `done:${projectId}:${assetId}`;
    let jobId: string | undefined;

    if (version === undefined) {
      const top = await this.#r.zrevrange(key, 0, 0);
      jobId = top[0];
    } else {
      const ids = await this.#r.zrangebyscore(key, version, version);
      jobId = ids[0];
    }
    return jobId ? this.get(jobId) : null;
  }

  async countSince(principal: string, sinceMs: number): Promise<number> {
    return this.#r.zcount(`principal:${principal}`, sinceMs, "+inf");
  }

  async close(): Promise<void> {
    await this.#r.quit();
  }
}

export class RedisJobQueue implements JobQueue {
  #r: Redis;
  /** Kết nối RIÊNG cho lệnh chặn: BRPOPLPUSH giữ kết nối, dùng chung
   *  một kết nối sẽ làm mọi lệnh khác xếp hàng sau nó. */
  #blocking: Redis;
  #limit: number;

  constructor(opts: RedisOptions) {
    this.#r = connect(opts.url);
    this.#blocking = connect(opts.url);
    this.#limit = opts.queueLimit;
  }

  async enqueue(payload: JobPayload): Promise<void> {
    const depth = await this.#r.llen(QUEUE);
    if (depth >= this.#limit) {
      throw new ImagegenError(
        "RATE_LIMITED",
        `Hàng đợi đã đầy (${this.#limit} việc đang chờ). Thử lại sau.`,
      );
    }
    await this.#r.lpush(QUEUE, JSON.stringify(payload));
  }

  async dequeue(timeoutMs: number): Promise<JobPayload | null> {
    // ioredis nhận timeout theo GIÂY; 0 nghĩa là chờ mãi nên phải chặn
    // dưới ở 1 để vòng lặp consumer còn kiểm được tín hiệu dừng.
    const seconds = Math.max(1, Math.round(timeoutMs / 1000));
    const raw = await this.#blocking.brpoplpush(QUEUE, PROCESSING, seconds);
    return raw ? (JSON.parse(raw) as JobPayload) : null;
  }

  async ack(jobId: string): Promise<void> {
    // Bỏ đúng phần tử của job này khỏi `processing`. Quét cả danh sách
    // vì nó rất ngắn (đúng bằng số việc đang chạy, mặc định 1).
    const items = await this.#r.lrange(PROCESSING, 0, -1);
    for (const it of items) {
      try {
        if ((JSON.parse(it) as JobPayload).jobId === jobId) {
          await this.#r.lrem(PROCESSING, 1, it);
          return;
        }
      } catch {
        // Phần tử hỏng thì bỏ đi, đừng để nó kẹt lại mãi.
        await this.#r.lrem(PROCESSING, 1, it);
      }
    }
  }

  /**
   * Việc còn nằm trong `processing` lúc worker khởi động là tàn dư của
   * lần chết trước — tiến trình Codex đã đi theo pod và không bao giờ
   * chạy tiếp. Trả về để bên gọi đánh dấu `failed`, thay vì để job treo
   * ở "running" khiến Claude poll vô hạn.
   */
  async reapStale(): Promise<JobPayload[]> {
    const items = await this.#r.lrange(PROCESSING, 0, -1);
    await this.#r.del(PROCESSING);
    const out: JobPayload[] = [];
    for (const it of items) {
      try {
        out.push(JSON.parse(it) as JobPayload);
      } catch {
        /* bỏ phần tử hỏng */
      }
    }
    return out;
  }

  async requestCancel(jobId: string): Promise<void> {
    // TTL 1 giờ: cờ chỉ cần sống lâu hơn một job, giữ mãi là rác.
    await this.#r.set(`cancel:${jobId}`, "1", "EX", 3600);
  }

  async isCancelled(jobId: string): Promise<boolean> {
    return (await this.#r.exists(`cancel:${jobId}`)) === 1;
  }

  async depth(): Promise<number> {
    return this.#r.llen(QUEUE);
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.#r.quit(), this.#blocking.quit()]);
  }
}
