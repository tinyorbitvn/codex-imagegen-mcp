import { test, describe } from "node:test";
import assert from "node:assert/strict";

import type { ImageSpec } from "@tinyorbit/contracts";
import { buildCodexArgv, buildCodexEnv, classifyCodexFailure } from "../src/runner.ts";
import { buildCreatePrompt, buildEditPrompt, specHash } from "../src/prompt.ts";
import { artifactKey } from "../src/consumer.ts";

const spec: ImageSpec = {
  projectId: "tinyorbit-cloud",
  assetId: "homepage-hero-vps",
  description: "Máy chủ VPS ba chiều",
  stylePrompt: "3D illustration\nclaymorphism",
  styleReference: "tinyorbit-cloud-v1",
  aspectRatio: "1:1",
  width: 1536,
  height: 1536,
  transparentBackground: true,
  outputFormat: "png",
  isolatedObject: true,
  safePaddingPercent: 12,
  filename: "artifact.png",
};

describe("buildCodexArgv", () => {
  test("prompt luôn là MỘT phần tử argv duy nhất", () => {
    // Bài test quan trọng nhất của cả bộ: chừng nào prompt còn là một
    // phần tử, không cú pháp shell nào trong đó có hiệu lực.
    const nasty = 'vẽ logo"; rm -rf / #\n$(whoami)\n`id`';
    const argv = buildCodexArgv("codex", nasty);
    assert.equal(argv.at(-1), nasty);
    assert.equal(argv.filter((a) => a === nasty).length, 1);
  });

  test("không sinh ra phần tử nào chứa cú pháp shell", () => {
    const argv = buildCodexArgv("codex", "x");
    assert.ok(!argv.some((a) => a === "-c" || a === "sh" || a === "bash"));
  });

  test("tắt sandbox nội bộ của Codex (bwrap không chạy được trong pod)", () => {
    // Sandbox thật là chính container (drop ALL, non-root, rootfs chỉ
    // đọc). bwrap của Codex cần user namespace không đặc quyền nên chết
    // trong pod, và Codex khi đó thoát mã 0 mà KHÔNG ghi file — hỏng câm.
    // Xem lý do đầy đủ ở buildCodexArgv.
    const argv = buildCodexArgv("codex", "x");
    const i = argv.indexOf("--sandbox");
    assert.ok(i > 0, "phải truyền --sandbox");
    assert.equal(argv[i + 1], "danger-full-access");
    // Giá trị sandbox KHÔNG được là phần tử cuối — prompt mới là cuối.
    assert.notEqual(i + 1, argv.length - 1);
  });

  test("xuống dòng trong prompt không tách thành tham số mới", () => {
    // Khẳng định BẤT BIẾN, không ghim con số: prompt nhiều dòng phải cho
    // ra đúng số phần tử như prompt một dòng, và vẫn nằm gọn ở phần tử
    // cuối. Ghim `length === 4` như bản cũ làm test đỏ mỗi lần thêm một
    // cờ hợp lệ (đã đỏ thật khi thêm --sandbox), che mất điều đang muốn
    // kiểm là "xuống dòng không tách tham số".
    const nhieuDong = "dòng 1\ndòng 2\ndòng 3";
    const argv = buildCodexArgv("codex", nhieuDong);
    const motDong = buildCodexArgv("codex", "x");
    assert.equal(argv.length, motDong.length);
    assert.equal(argv.at(-1), nhieuDong);
  });
});

describe("buildCodexEnv", () => {
  test("KHÔNG chuyển OPENAI_API_KEY xuống tiến trình con", () => {
    // Chốt chặn spec §15/§31: kể cả pod có biến này, Codex cũng không
    // thấy, nên không có đường nào âm thầm tính tiền qua API key.
    const env = buildCodexEnv("/home/codex/.codex", {
      OPENAI_API_KEY: "sk-không-được-phép",
      PATH: "/usr/bin",
    });
    assert.equal(env.OPENAI_API_KEY, undefined);
  });

  test("KHÔNG chuyển key S3, mật khẩu Redis hay biến nội bộ nào khác", () => {
    const env = buildCodexEnv("/home/codex/.codex", {
      AWS_ACCESS_KEY_ID: "AKIA",
      AWS_SECRET_ACCESS_KEY: "bí mật",
      REDIS_URL: "redis://:pw@redis:6379",
      S3_ENDPOINT: "http://rgw",
      PATH: "/usr/bin",
    });
    assert.equal(env.AWS_ACCESS_KEY_ID, undefined);
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(env.REDIS_URL, undefined);
    assert.equal(env.S3_ENDPOINT, undefined);
  });

  test("chỉ có đúng các khoá trong danh sách cho phép", () => {
    const env = buildCodexEnv("/home/codex/.codex", { PATH: "/usr/bin", RANDOM_VAR: "x" });
    assert.deepEqual(Object.keys(env).sort(), [
      "CODEX_HOME", "HOME", "LANG", "PATH", "TERM", "TMPDIR",
    ]);
  });
});

describe("classifyCodexFailure", () => {
  test("nhận ra phiên đăng nhập hết hạn", () => {
    for (const s of [
      "Error: not logged in",
      "please run codex login first",
      "HTTP 401 Unauthorized",
      "session expired, re-authenticate",
    ]) {
      assert.equal(classifyCodexFailure(s), "CODEX_NOT_AUTHENTICATED", s);
    }
  });

  test("nhận ra tài khoản KHÔNG có khả năng sinh ảnh", () => {
    // Spec §31: phải phân biệt được với "chưa đăng nhập", vì hai tình
    // huống này cần hai hành động khắc phục khác hẳn nhau.
    for (const s of [
      "image generation is not available on your plan",
      "unsupported capability: images",
      "no such tool: image_gen",
      "please upgrade your plan",
    ]) {
      assert.equal(classifyCodexFailure(s), "IMAGE_CAPABILITY_UNAVAILABLE", s);
    }
  });

  test("không đoán được thì rơi về lỗi chung, KHÔNG đoán bừa", () => {
    assert.equal(classifyCodexFailure("segfault at 0x0"), "IMAGE_GENERATION_FAILED");
    assert.equal(classifyCodexFailure(""), "IMAGE_GENERATION_FAILED");
  });
});

describe("buildCreatePrompt", () => {
  test("đường dẫn đầu ra do worker cấp, xuất hiện tường minh", () => {
    const p = buildCreatePrompt(spec, "/work/jobs/img_abc");
    assert.match(
      p,
      /Save the final generated asset to exactly this path: \/work\/jobs\/img_abc\/artifact\.png/,
    );
  });

  test("khoá phạm vi Codex lại, không cho làm việc khác", () => {
    const p = buildCreatePrompt(spec, "/work/jobs/img_abc");
    assert.match(p, /Do not write any other file\./);
    assert.match(p, /Apart from that, do not read or modify anything outside that directory\./);
    // Ngoại lệ BẮT BUỘC phải có: thiếu nó thì Codex từ chối chép chính
    // tấm ảnh nó vừa sinh, rồi thoát 0 — hỏng câm, mất một lượt quota.
    assert.match(p, /You may read the image-generation tool's own output directory/);
    assert.match(p, /Do not perform unrelated tasks\./);
  });

  test("isolated_object sinh ra yêu cầu tách vật thể — điều kiện để làm animation", () => {
    // Spec §21: nhiều vật chuyển động độc lập thì mỗi vật phải là một
    // artifact riêng trên nền trong suốt.
    const p = buildCreatePrompt(spec, "/d");
    assert.match(p, /isolated object: render ONLY the requested subject/);
    assert.match(p, /no neighboring objects/);

    const flat = buildCreatePrompt({ ...spec, isolatedObject: false }, "/d");
    assert.doesNotMatch(flat, /isolated object: render ONLY/);
  });

  test("nền trong suốt sinh ra yêu cầu alpha, nền đục thì không", () => {
    assert.match(buildCreatePrompt(spec, "/d"), /transparent background \(alpha channel\)/);
    assert.match(
      buildCreatePrompt({ ...spec, transparentBackground: false }, "/d"),
      /opaque background/,
    );
  });

  test("nhúng style profile đã phân giải, không phải tên profile", () => {
    const p = buildCreatePrompt(spec, "/d");
    assert.match(p, /Style:\n3D illustration\nclaymorphism/);
    // Tên profile KHÔNG đi vào prompt — Codex cần nội dung, không cần mã.
    assert.doesNotMatch(p, /tinyorbit-cloud-v1/);
  });

  test("nhúng kích thước và safe padding đã cho", () => {
    const p = buildCreatePrompt(spec, "/d");
    assert.match(p, /1536 x 1536/);
    assert.match(p, /at least 12% safe padding/);
  });
});

describe("buildEditPrompt", () => {
  test("cấm ghi đè ảnh nguồn", () => {
    const p = buildEditPrompt(spec, "thu nhỏ máy chủ", "source.png", "/work/jobs/img_def");
    assert.match(p, /Do not overwrite the source image\./);
    assert.match(p, /Source image file: \/work\/jobs\/img_def\/source\.png/);
    assert.match(
      p,
      /Save the edited artifact to exactly this path: \/work\/jobs\/img_def\/artifact\.png/,
    );
  });
});

describe("artifactKey", () => {
  test("dựng đúng bố cục thư mục theo spec §19", () => {
    assert.equal(
      artifactKey("tinyorbit-cloud", "homepage-hero-vps", 2, "artifact.png"),
      "projects/tinyorbit-cloud/homepage-hero-vps/v2/artifact.png",
    );
  });
});

describe("specHash", () => {
  test("ổn định và khác nhau theo nội dung", () => {
    assert.equal(specHash("a"), specHash("a"));
    assert.notEqual(specHash("a"), specHash("b"));
    assert.match(specHash("a"), /^[0-9a-f]{64}$/);
  });
});
