// Test hợp đồng MCP + vòng đời job của imagegen-mcp.
//
// Dùng JobStore/JobQueue trong bộ nhớ nên chạy được không cần Redis —
// đúng cách spec §29 Phase 2 đề nghị: chốt hợp đồng trước, Codex sau.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { ImagegenError } from "@tinyorbit/contracts";
import type { ArtifactRef, JobPayload } from "@tinyorbit/contracts";
import { InMemoryJobQueue, InMemoryJobStore } from "@tinyorbit/job-queue";

import { ImagegenService } from "../src/service.ts";

function build(limits = { createImagePerHour: 100, editImagePerHour: 100 }) {
  const store = new InMemoryJobStore();
  const queue = new InMemoryJobQueue();
  const service = new ImagegenService({ store, queue, config: { rateLimit: limits } });
  return { service, store, queue };
}

/** Giả lập worker hoàn tất một việc ĐÃ LẤY khỏi hàng đợi. */
async function completePayload(
  payload: JobPayload,
  store: InMemoryJobStore,
  queue: InMemoryJobQueue,
): Promise<ArtifactRef> {
  const { spec, version, parentVersion, jobId } = payload;
  const artifact: ArtifactRef = {
    projectId: spec.projectId,
    assetId: spec.assetId,
    version,
    parentVersion,
    key: `projects/${spec.projectId}/${spec.assetId}/v${version}/${spec.filename}`,
    url: `https://s3.example/mcp-artifacts/projects/${spec.projectId}/${spec.assetId}/v${version}/${spec.filename}`,
    mimeType: spec.outputFormat === "png" ? "image/png" : "image/webp",
    width: spec.width,
    height: spec.height,
    transparent: spec.transparentBackground,
    specHash: "deadbeef",
    createdAt: new Date().toISOString(),
  };
  await store.markCompleted(jobId, artifact);
  await queue.ack(jobId);
  return artifact;
}

/** Tiện lợi: lấy việc kế tiếp rồi hoàn tất nó. */
async function completeNextJob(
  queue: InMemoryJobQueue,
  store: InMemoryJobStore,
): Promise<ArtifactRef> {
  const payload = await queue.dequeue(1000);
  assert.ok(payload, "phải có việc trong hàng đợi");
  return completePayload(payload!, store, queue);
}

describe("create_image", () => {
  test("trả job_id ngay và đẩy đúng một việc vào hàng đợi", async () => {
    // Spec §12: request MCP không được giữ mở suốt thời gian render.
    const { service, queue } = build();
    const r = await service.createImage(
      {
        project_id: "tinyorbit-cloud",
        asset_id: "homepage-hero-vps",
        description: "máy chủ VPS",
      },
      "claude-design",
    );
    assert.match(r.job_id, /^img_[0-9a-f]{32}$/);
    assert.equal(r.status, "queued");
    assert.equal(await queue.depth(), 1);
  });

  test("mặc định: nền trong suốt, tách vật thể, png", async () => {
    // Ba mặc định này là thứ khiến artifact dùng được cho animation web
    // mà không phải nêu lại mỗi lần (spec §21).
    const { service, queue } = build();
    await service.createImage(
      { project_id: "p", asset_id: "a", description: "x" },
      "claude-design",
    );
    const payload = await queue.dequeue(1000);
    assert.equal(payload!.spec.transparentBackground, true);
    assert.equal(payload!.spec.isolatedObject, true);
    assert.equal(payload!.spec.outputFormat, "png");
    assert.equal(payload!.spec.safePaddingPercent, 12);
  });

  test("style.reference được phân giải thành nội dung profile", async () => {
    const { service, queue } = build();
    await service.createImage(
      {
        project_id: "p",
        asset_id: "a",
        description: "x",
        style: { reference: "tinyorbit-cloud-v1" },
      },
      "claude-design",
    );
    const payload = await queue.dequeue(1000);
    assert.match(payload!.spec.stylePrompt, /claymorphism/);
    assert.match(payload!.spec.stylePrompt, /#2E5BFF/);
    assert.equal(payload!.spec.styleReference, "tinyorbit-cloud-v1");
  });

  test("style profile không tồn tại -> lỗi nói rõ tên hợp lệ", async () => {
    const { service } = build();
    await assert.rejects(
      () =>
        service.createImage(
          { project_id: "p", asset_id: "a", description: "x", style: { reference: "khong-co" } },
          "claude-design",
        ),
      (e: unknown) =>
        e instanceof ImagegenError &&
        e.code === "UNKNOWN_STYLE_PROFILE" &&
        /tinyorbit-cloud-v1/.test(e.message),
    );
  });

  test("từ chối project_id/asset_id không hợp lệ TRƯỚC khi tạo job", async () => {
    const { service, queue } = build();
    await assert.rejects(
      () =>
        service.createImage(
          { project_id: "../etc", asset_id: "a", description: "x" },
          "claude-design",
        ),
      (e: unknown) => e instanceof ImagegenError && e.code === "INVALID_PROJECT",
    );
    await assert.rejects(
      () =>
        service.createImage(
          { project_id: "p", asset_id: "a; rm -rf /", description: "x" },
          "claude-design",
        ),
      (e: unknown) => e instanceof ImagegenError && e.code === "INVALID_ASSET_ID",
    );
    // Không việc nào lọt vào hàng đợi — kiểm chặn TRƯỚC khi tốn tài nguyên.
    assert.equal(await queue.depth(), 0);
  });

  test("hàng đợi đầy thì từ chối ngay bằng RATE_LIMITED", async () => {
    const store = new InMemoryJobStore();
    const queue = new InMemoryJobQueue(2);
    const service = new ImagegenService({
      store,
      queue,
      config: { rateLimit: { createImagePerHour: 100, editImagePerHour: 100 } },
    });
    for (const id of ["a1", "a2"]) {
      await service.createImage(
        { project_id: "p", asset_id: id, description: "x" },
        "claude-design",
      );
    }
    await assert.rejects(
      () =>
        service.createImage(
          { project_id: "p", asset_id: "a3", description: "x" },
          "claude-design",
        ),
      (e: unknown) => e instanceof ImagegenError && e.code === "RATE_LIMITED",
    );
  });
});

describe("đánh số phiên bản", () => {
  test("cấp số từ mốc ĐÃ CẤP nên hai job song song không trùng version", async () => {
    // Nếu cấp theo bản đã hoàn tất, cả hai job cùng nhận v1 và job sau
    // ghi đè job trước trên object storage.
    const { service, queue } = build();
    await service.createImage(
      { project_id: "p", asset_id: "a", description: "x" },
      "claude-design",
    );
    await service.createImage(
      { project_id: "p", asset_id: "a", description: "y" },
      "claude-design",
    );
    const first = await queue.dequeue(1000);
    const second = await queue.dequeue(1000);
    assert.equal(first!.version, 1);
    assert.equal(second!.version, 2, "job thứ hai phải nhận version khác");
  });

  test("job thất bại trả lại số phiên bản cho lần sau", async () => {
    const { service, store, queue } = build();
    const r = await service.createImage(
      { project_id: "p", asset_id: "a", description: "x" },
      "claude-design",
    );
    await queue.dequeue(1000);
    await store.markFailed(r.job_id, "IMAGE_GENERATION_FAILED", "hỏng");
    assert.equal(await store.highestAllocatedVersion("p", "a"), 0);
  });
});

describe("edit_image", () => {
  test("sinh version mới và giữ phả hệ, KHÔNG ghi đè bản cũ", async () => {
    const { service, store, queue } = build();
    await service.createImage(
      { project_id: "p", asset_id: "a", description: "x" },
      "claude-design",
    );
    await completeNextJob(queue, store);

    const e = await service.editImage(
      { project_id: "p", asset_id: "a", instructions: "thu nhỏ lại" },
      "claude-design",
    );
    const payload = await queue.dequeue(1000);
    assert.equal(payload!.kind, "edit");
    assert.equal(payload!.version, 2);
    assert.equal(payload!.parentVersion, 1, "phải giữ phả hệ");
    assert.match(payload!.sourceKey!, /\/v1\//, "phải trỏ đúng ảnh nguồn v1");

    await completePayload(payload!, store, queue);
    const res = (await service.getImageJob(e.job_id)) as any;
    assert.equal(res.artifact.version, 2);
    assert.equal(res.artifact.parent_version, 1);

    // v1 vẫn truy vấn được — bằng chứng không bị ghi đè (spec §11).
    const v1 = (await service.getArtifact({ project_id: "p", asset_id: "a", version: 1 })) as any;
    assert.equal(v1.artifact.version, 1);
  });

  test("sửa artifact không tồn tại thì báo JOB_NOT_FOUND", async () => {
    const { service } = build();
    await assert.rejects(
      () =>
        service.editImage(
          { project_id: "p", asset_id: "chua-co", instructions: "x" },
          "claude-design",
        ),
      (e: unknown) => e instanceof ImagegenError && e.code === "JOB_NOT_FOUND",
    );
  });
});

describe("get_artifact", () => {
  test("bỏ trống version thì trả bản mới nhất", async () => {
    const { service, store, queue } = build();
    await service.createImage(
      { project_id: "p", asset_id: "a", description: "x" },
      "claude-design",
    );
    await completeNextJob(queue, store);
    await service.editImage(
      { project_id: "p", asset_id: "a", instructions: "y" },
      "claude-design",
    );
    await completeNextJob(queue, store);

    const latest = (await service.getArtifact({ project_id: "p", asset_id: "a" })) as any;
    assert.equal(latest.artifact.version, 2);
  });
});

describe("cancel_image_job", () => {
  test("huỷ job đang chờ và đặt cờ huỷ cho worker", async () => {
    const { service, queue } = build();
    const r = await service.createImage(
      { project_id: "p", asset_id: "a", description: "x" },
      "claude-design",
    );
    const out = (await service.cancelImageJob(r.job_id)) as any;
    assert.equal(out.status, "cancelled");
    // Cờ huỷ là thứ khiến worker dừng thật chứ không chỉ đổi trạng thái
    // trên giấy — không có nó thì Codex vẫn chạy hết và vẫn tốn quota.
    assert.equal(await queue.isCancelled(r.job_id), true);
  });

  test("KHÔNG huỷ được job đã hoàn tất", async () => {
    const { service, store, queue } = build();
    const r = await service.createImage(
      { project_id: "p", asset_id: "a", description: "x" },
      "claude-design",
    );
    await completeNextJob(queue, store);
    await assert.rejects(
      () => service.cancelImageJob(r.job_id),
      (e: unknown) => e instanceof ImagegenError && e.code === "JOB_CANCELLED",
    );
  });
});

describe("rate limit", () => {
  test("tính theo từng chủ thể", async () => {
    const { service } = build({ createImagePerHour: 2, editImagePerHour: 2 });
    await service.createImage({ project_id: "p", asset_id: "a1", description: "x" }, "claude");
    await service.createImage({ project_id: "p", asset_id: "a2", description: "x" }, "claude");
    await assert.rejects(
      () => service.createImage({ project_id: "p", asset_id: "a3", description: "x" }, "claude"),
      (e: unknown) => e instanceof ImagegenError && e.code === "RATE_LIMITED",
    );
    // Người khác vẫn gọi được.
    assert.ok(
      await service.createImage({ project_id: "p", asset_id: "a4", description: "x" }, "mai"),
    );
  });
});

describe("waitForImage — chờ và báo tiến độ", () => {
  test("trả artifact khi job xong, kèm timed_out=false", async () => {
    const { service, store, queue } = build();
    const h = await service.createImage(
      { project_id: "p", asset_id: "a", description: "khối lập phương" },
      "test",
    );
    // Worker giả hoàn tất sau khi vòng chờ đã bắt đầu.
    const done = service.waitForImage({ job_id: h.job_id, timeout_seconds: 30 }, { pollMs: 5 });
    await completeNextJob(queue, store);
    const r = await done;
    assert.equal(r.status, "completed");
    assert.equal(r.timed_out, false);
    assert.ok((r.artifact as { url: string }).url.startsWith("https://"));
  });

  test("báo tiến độ MỖI LẦN ĐỔI trạng thái, không spam mỗi vòng lặp", async () => {
    // Quan trọng: client hiển thị tiến độ, nên phát mỗi 3 giây một dòng
    // "vẫn đang chạy" là rác. Chỉ phát khi trạng thái thật sự đổi.
    const { service, store, queue } = build();
    const h = await service.createImage(
      { project_id: "p", asset_id: "a", description: "x" },
      "test",
    );
    const seen: string[] = [];
    const done = service.waitForImage(
      { job_id: h.job_id, timeout_seconds: 30 },
      { pollMs: 5, onProgress: ({ status }) => void seen.push(status) },
    );
    const payload = await queue.dequeue(1000);
    await store.markRunning(payload!.jobId);
    // Chờ vài nhịp để vòng lặp kịp lấy mẫu trạng thái `running` trước khi
    // job nhảy sang completed — với nhịp 5ms thì 60ms là dư.
    await new Promise((r) => setTimeout(r, 60));
    await completePayload(payload!, store, queue);
    await done;
    assert.deepEqual(seen, ["queued", "running", "completed"]);
  });

  test("hết giờ KHÔNG phải lỗi và KHÔNG huỷ job", async () => {
    // Job đã tiêu quota ChatGPT rồi; huỷ vì ta sốt ruột là ném tiền đi.
    const { service, store } = build();
    const h = await service.createImage(
      { project_id: "p", asset_id: "a", description: "x" },
      "test",
    );
    // timeout_seconds nhỏ hơn min của schema là CỐ Ý: waitForImage không
    // validate schema (validation nằm ở tầng tool), nên test giữ được tính
    // tất định mà không phải ngồi chờ 10 giây thật.
    const r = await service.waitForImage({ job_id: h.job_id, timeout_seconds: 0.2 }, { pollMs: 5 });
    assert.equal(r.timed_out, true);
    assert.equal(r.status, "queued");
    const still = await store.get(h.job_id);
    assert.equal(still!.status, "queued", "job phải còn nguyên để worker chạy tiếp");
  });

  test("client ngắt thì dừng chờ, job vẫn nguyên", async () => {
    const { service, store } = build();
    const h = await service.createImage(
      { project_id: "p", asset_id: "a", description: "x" },
      "test",
    );
    const ac = new AbortController();
    ac.abort();
    const r = await service.waitForImage(
      { job_id: h.job_id, timeout_seconds: 30 },
      { signal: ac.signal, pollMs: 5 },
    );
    assert.equal(r.aborted, true);
    assert.equal((await store.get(h.job_id))!.status, "queued");
  });

  test("job_id không tồn tại -> JOB_NOT_FOUND", async () => {
    const { service } = build();
    await assert.rejects(
      () => service.waitForImage({ job_id: "img_khongcothat", timeout_seconds: 10 }, { pollMs: 5 }),
      (e: unknown) => (e as ImagegenError).code === "JOB_NOT_FOUND",
    );
  });
});
