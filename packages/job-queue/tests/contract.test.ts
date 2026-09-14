// Hợp đồng mà MỌI cài đặt JobStore/JobQueue phải giữ.
//
// Chạy trên bản in-memory vì nó không cần Redis. Bản Redis
// (RedisJobStore/RedisJobQueue) PHẢI hành xử y hệt — các bất biến dưới
// đây được cài song song ở cả hai file, và đây là chỗ ghi lại chúng.
//
// Muốn chạy cùng bộ này với Redis thật thì dựng một Redis rồi thay
// factory ở đầu file; mọi assert giữ nguyên.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { ImagegenError } from "@tinyorbit/contracts";
import type { ArtifactRef, JobPayload, JobRecord } from "@tinyorbit/contracts";
import { InMemoryJobQueue, InMemoryJobStore } from "../src/memory.ts";

function record(over: Partial<JobRecord> = {}): JobRecord {
  return {
    jobId: "img_1", status: "queued", projectId: "p", assetId: "a",
    version: 1, parentVersion: null, principal: "claude-design",
    createdAt: new Date().toISOString(), startedAt: null, completedAt: null,
    artifact: null, errorCode: null, errorMessage: null, traceId: null,
    ...over,
  };
}

function artifact(version = 1): ArtifactRef {
  return {
    projectId: "p", assetId: "a", version, parentVersion: null,
    key: `projects/p/a/v${version}/artifact.png`, url: "https://s3.example/x",
    mimeType: "image/png", width: 1536, height: 1536, transparent: true,
    specHash: "deadbeef", createdAt: new Date().toISOString(),
  };
}

function payload(jobId: string): JobPayload {
  return {
    jobId, kind: "create", version: 1, parentVersion: null,
    sourceKey: null, instructions: null,
    spec: {
      projectId: "p", assetId: "a", description: "x", stylePrompt: "",
      styleReference: null, aspectRatio: "1:1", width: 1536, height: 1536,
      transparentBackground: true, outputFormat: "png", isolatedObject: true,
      safePaddingPercent: 12, filename: "artifact.png",
    },
  };
}

describe("JobStore — bất biến trạng thái", () => {
  test("queued -> running -> completed", async () => {
    const s = new InMemoryJobStore();
    await s.create(record());
    await s.markRunning("img_1");
    assert.equal((await s.get("img_1"))!.status, "running");
    await s.markCompleted("img_1", artifact());
    const done = (await s.get("img_1"))!;
    assert.equal(done.status, "completed");
    assert.equal(done.artifact!.version, 1);
  });

  test("job đã completed KHÔNG bị markFailed ghi đè", async () => {
    // Bảo vệ artifact đã phát hành: một lượt dọn dẹp muộn không được
    // biến job thành công thành thất bại.
    const s = new InMemoryJobStore();
    await s.create(record());
    await s.markCompleted("img_1", artifact());
    await s.markFailed("img_1", "IMAGE_GENERATION_FAILED", "muộn");
    assert.equal((await s.get("img_1"))!.status, "completed");
  });

  test("chỉ huỷ được job đang chờ hoặc đang chạy", async () => {
    const s = new InMemoryJobStore();
    await s.create(record({ jobId: "img_q" }));
    assert.equal(await s.markCancelled("img_q"), true);

    await s.create(record({ jobId: "img_done" }));
    await s.markCompleted("img_done", artifact(9));
    assert.equal(await s.markCancelled("img_done"), false);
    assert.equal((await s.get("img_done"))!.status, "completed");
  });
});

describe("JobStore — cấp phát phiên bản", () => {
  test("đếm theo mốc ĐÃ CẤP, không phải mốc đã hoàn tất", async () => {
    // Nếu cấp theo bản hoàn tất thì hai job song song cùng nhận v1 và
    // job sau ghi đè job trước trên object storage.
    const s = new InMemoryJobStore();
    await s.create(record({ jobId: "img_1", version: 1 }));
    assert.equal(await s.highestAllocatedVersion("p", "a"), 1);
    assert.equal(await s.getArtifact("p", "a"), null, "chưa có bản hoàn tất nào");
  });

  test("job thất bại trả số phiên bản lại cho lần sau", async () => {
    const s = new InMemoryJobStore();
    await s.create(record({ jobId: "img_1", version: 1 }));
    await s.markFailed("img_1", "IMAGE_GENERATION_FAILED", "x");
    assert.equal(await s.highestAllocatedVersion("p", "a"), 0);
  });

  test("getArtifact bỏ trống version thì lấy bản mới nhất", async () => {
    const s = new InMemoryJobStore();
    for (const v of [1, 2, 3]) {
      await s.create(record({ jobId: `img_${v}`, version: v }));
      await s.markCompleted(`img_${v}`, artifact(v));
    }
    assert.equal((await s.getArtifact("p", "a"))!.version, 3);
    assert.equal((await s.getArtifact("p", "a", 2))!.version, 2);
    assert.equal(await s.getArtifact("p", "a", 99), null);
  });
});

describe("JobQueue — bất biến hàng đợi", () => {
  test("FIFO", async () => {
    const q = new InMemoryJobQueue();
    await q.enqueue(payload("img_1"));
    await q.enqueue(payload("img_2"));
    assert.equal((await q.dequeue(500))!.jobId, "img_1");
    assert.equal((await q.dequeue(500))!.jobId, "img_2");
  });

  test("hàng đợi rỗng thì dequeue trả null sau timeout, KHÔNG treo", async () => {
    // Quan trọng: vòng lặp consumer phải quay lại kiểm được cờ dừng,
    // nếu không pod chỉ tắt khi bị SIGKILL.
    const q = new InMemoryJobQueue();
    const t0 = Date.now();
    assert.equal(await q.dequeue(100), null);
    assert.ok(Date.now() - t0 >= 90);
  });

  test("vượt trần thì ném RATE_LIMITED chứ không xếp hàng vô hạn", async () => {
    const q = new InMemoryJobQueue(2);
    await q.enqueue(payload("img_1"));
    await q.enqueue(payload("img_2"));
    await assert.rejects(
      () => q.enqueue(payload("img_3")),
      (e: unknown) => e instanceof ImagegenError && e.code === "RATE_LIMITED",
    );
  });

  test("việc chưa ack còn trong processing và reapStale nhặt lại được", async () => {
    // Đây là thứ giữ cho job không treo ở "running" mãi khi worker chết
    // giữa chừng (spec §30).
    const q = new InMemoryJobQueue();
    await q.enqueue(payload("img_1"));
    await q.dequeue(500);
    assert.deepEqual((await q.reapStale()).map((p) => p.jobId), ["img_1"]);
    assert.deepEqual(await q.reapStale(), [], "nhặt rồi thì không nhặt lại");
  });

  test("ack xong thì reapStale không thấy nữa", async () => {
    const q = new InMemoryJobQueue();
    await q.enqueue(payload("img_1"));
    await q.dequeue(500);
    await q.ack("img_1");
    assert.deepEqual(await q.reapStale(), []);
  });

  test("cờ huỷ đọc lại được", async () => {
    const q = new InMemoryJobQueue();
    assert.equal(await q.isCancelled("img_1"), false);
    await q.requestCancel("img_1");
    assert.equal(await q.isCancelled("img_1"), true);
  });
});
