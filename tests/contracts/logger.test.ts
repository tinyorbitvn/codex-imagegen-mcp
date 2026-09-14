// Locks down the log's secret-redaction behavior.
//
// This suite is the only automated proof of the promise that logs never
// contain a token or secret — worth keeping intact on its own even as the
// surrounding code gets refactored.

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

import { redact, log, setServiceName } from "../../src/contracts/logger.ts";

describe("redact", () => {
  test("redacts every key that looks like a secret, by NAME", () => {
    const out = redact({
      AWS_SECRET_ACCESS_KEY: "supersecret",
      client_secret: "supersecret",
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
      assert.equal(out[k], "[redacted]", `key ${k} must be redacted`);
    }
    // Non-sensitive values must pass through untouched, or the log is useless.
    assert.equal(out.job_id, "img_1");
  });

  test("redacts keys nested deep inside", () => {
    const out = redact({ a: { b: { c: { refresh_token: "x" } } } }) as any;
    assert.equal(out.a.b.c.refresh_token, "[redacted]");
  });

  test("redacts inside array elements", () => {
    const out = redact([{ token: "x" }, { ok: 1 }]) as any[];
    assert.equal(out[0].token, "[redacted]");
    assert.equal(out[1].ok, 1);
  });

  test("an Error keeps only name + message, not the stack", () => {
    // The stack often leaks internal paths and sometimes even variable values.
    const out = redact(new Error("boom")) as Record<string, unknown>;
    assert.deepEqual(out, { name: "Error", message: "boom" });
  });

  test("caps recursion depth instead of hanging", () => {
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

  test("service name is attached to every log line", () => {
    // The two services SHARE this package; a fixed name would mix the two
    // pods' logs together indistinguishably.
    const lines: string[] = [];
    process.stdout.write = ((chunk: string) => {
      lines.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    setServiceName("codex-image-worker");
    log.info("test", { job_id: "img_1" });

    const parsed = JSON.parse(lines[0]!);
    assert.equal(parsed.service, "codex-image-worker");
    assert.equal(parsed.job_id, "img_1");
    assert.equal(parsed.level, "info");
  });

  test("a secret in a field is still redacted when passed through log()", () => {
    const lines: string[] = [];
    process.stdout.write = ((chunk: string) => {
      lines.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    setServiceName("imagegen-mcp");
    log.info("test", { client_secret: "must-not-leak" });

    assert.doesNotMatch(lines[0]!, /must-not-leak/);
    assert.match(lines[0]!, /\[redacted\]/);
  });
});
