// Khoá hành vi lọc secret của log (spec §22).
//
// Bộ test này từng nằm trong service cũ và mất khi tách gói — mất nó là
// mất luôn thứ duy nhất chứng minh lời hứa "log không bao giờ chứa
// token/secret" trong docs/mcp/security.md.

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

import { redact, log, setServiceName } from "../src/logger.ts";

describe("redact", () => {
  test("che mọi khoá trông giống bí mật theo TÊN", () => {
    const out = redact({
      AWS_SECRET_ACCESS_KEY: "bí mật",
      client_secret: "bí mật",
      authorization: "Bearer abc",
      access_token: "abc",
      refresh_token: "abc",
      password: "abc",
      apiKey: "abc",
      privateKey: "abc",
      job_id: "img_1",
    }) as Record<string, unknown>;

    for (const k of [
      "AWS_SECRET_ACCESS_KEY", "client_secret", "authorization",
      "access_token", "refresh_token", "password", "apiKey", "privateKey",
    ]) {
      assert.equal(out[k], "[redacted]", `khoá ${k} phải bị che`);
    }
    // Giá trị không nhạy cảm phải đi qua nguyên vẹn, nếu không log vô dụng.
    assert.equal(out.job_id, "img_1");
  });

  test("che cả khoá lồng sâu bên trong", () => {
    const out = redact({ a: { b: { c: { refresh_token: "x" } } } }) as any;
    assert.equal(out.a.b.c.refresh_token, "[redacted]");
  });

  test("che trong phần tử của mảng", () => {
    const out = redact([{ token: "x" }, { ok: 1 }]) as any[];
    assert.equal(out[0].token, "[redacted]");
    assert.equal(out[1].ok, 1);
  });

  test("Error chỉ giữ name + message, không giữ stack", () => {
    // stack hay lộ đường dẫn nội bộ và đôi khi cả giá trị biến.
    const out = redact(new Error("bùm")) as Record<string, unknown>;
    assert.deepEqual(out, { name: "Error", message: "bùm" });
  });

  test("chặn đệ quy quá sâu thay vì treo", () => {
    const deep: any = {};
    let cur = deep;
    for (let i = 0; i < 20; i++) cur = cur.next = {};
    assert.doesNotThrow(() => redact(deep));
  });
});

describe("setServiceName", () => {
  const originalWrite = process.stdout.write.bind(process.stdout);
  afterEach(() => {
    process.stdout.write = originalWrite;
  });

  test("tên service đi vào mọi dòng log", () => {
    // Hai service dùng CHUNG gói này; tên cố định sẽ làm log của hai pod
    // trộn vào nhau không phân biệt được.
    const lines: string[] = [];
    process.stdout.write = ((chunk: string) => {
      lines.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    setServiceName("codex-image-worker");
    log.info("thử", { job_id: "img_1" });

    const parsed = JSON.parse(lines[0]!);
    assert.equal(parsed.service, "codex-image-worker");
    assert.equal(parsed.job_id, "img_1");
    assert.equal(parsed.level, "info");
  });

  test("secret trong field vẫn bị che khi đi qua log()", () => {
    const lines: string[] = [];
    process.stdout.write = ((chunk: string) => {
      lines.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    setServiceName("imagegen-mcp");
    log.info("thử", { client_secret: "không-được-lộ" });

    assert.doesNotMatch(lines[0]!, /không-được-lộ/);
    assert.match(lines[0]!, /\[redacted\]/);
  });
});
