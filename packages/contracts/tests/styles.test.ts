import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { STYLE_PROFILES, listStyleProfiles, resolveStyle } from "../src/styles.ts";

describe("style profile", () => {
  test("có sẵn profile tinyorbit-cloud-v1", () => {
    assert.ok(STYLE_PROFILES["tinyorbit-cloud-v1"]);
    assert.deepEqual(listStyleProfiles(), ["tinyorbit-cloud-v1"]);
  });

  test("profile mang đủ bảng màu và ràng buộc artifact web", () => {
    // Đây là bộ nhận diện — sai màu là artifact lệch thương hiệu mà
    // không ai nhận ra cho tới khi ghép lên trang.
    const p = STYLE_PROFILES["tinyorbit-cloud-v1"]!.prompt;
    for (const token of ["#000055", "#2E5BFF", "#CFE3FF", "#FFFFFF", "#46C3D8"]) {
      assert.match(p, new RegExp(token), `thiếu màu ${token}`);
    }
    assert.match(p, /claymorphism/);
    assert.match(p, /transparent background/);
    assert.match(p, /12% minimum safe padding/);
  });

  test("resolveStyle: profile đứng TRƯỚC chỉ dẫn thêm", () => {
    // Thứ tự có ý nghĩa: yêu cầu riêng lẻ tinh chỉnh profile, chứ không
    // bị profile ghi đè.
    const r = resolveStyle("tinyorbit-cloud-v1", "thêm ánh sáng viền xanh");
    const iProfile = r.prompt.indexOf("claymorphism");
    const iExtra = r.prompt.indexOf("thêm ánh sáng viền xanh");
    assert.ok(iProfile >= 0 && iExtra > iProfile, "profile phải đứng trước");
    assert.equal(r.reference, "tinyorbit-cloud-v1");
  });

  test("không có profile thì chỉ còn chỉ dẫn thêm", () => {
    const r = resolveStyle(undefined, "chỉ dẫn tự do");
    assert.equal(r.prompt, "chỉ dẫn tự do");
    assert.equal(r.reference, null);
  });

  test("không có gì thì trả chuỗi rỗng, không ném lỗi", () => {
    const r = resolveStyle(undefined, undefined);
    assert.equal(r.prompt, "");
    assert.equal(r.reference, null);
  });

  test("profile không tồn tại thì ném lỗi CÓ NÊU TÊN hợp lệ", () => {
    // Thông điệp phải hành động được: người gọi cần biết gõ gì cho đúng.
    assert.throws(
      () => resolveStyle("khong-ton-tai", undefined),
      (e: unknown) => e instanceof Error && /tinyorbit-cloud-v1/.test(e.message),
    );
  });
});
