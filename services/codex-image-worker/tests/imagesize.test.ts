// Đọc kích thước ảnh từ header.
//
// Ảnh PNG trong test được DỰNG THẬT bằng zlib (có IDAT hợp lệ), không
// phải header giả, để bộ đọc bị ràng đúng thứ nó sẽ gặp lúc chạy.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseImageHeader, readImageInfo } from "../src/imagesize.ts";

/** Dựng một PNG hợp lệ tối thiểu. colorType: 2=RGB, 6=RGBA, 3=bảng màu. */
function pngThat(width: number, height: number, colorType: number, themTrns = false): Buffer {
  const kenh = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]!;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // độ sâu bit
  ihdr[9] = colorType;

  // Mỗi hàng: 1 byte filter + width*kênh byte dữ liệu.
  const raw = Buffer.alloc(height * (1 + width * kenh));
  const idat = deflateSync(raw);

  const chunks: Buffer[] = [chunk("IHDR", ihdr)];
  if (colorType === 3) chunks.push(chunk("PLTE", Buffer.alloc(3)));
  if (themTrns) chunks.push(chunk("tRNS", Buffer.from([0])));
  chunks.push(chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0)));

  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks]);
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  // CRC không được bộ đọc kiểm, nhưng để 0 thì file vẫn đúng cấu trúc
  // chuỗi chunk — đó mới là thứ hàm dò tRNS đi theo.
  return Buffer.concat([len, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
}

describe("parseImageHeader — PNG", () => {
  test("đọc đúng chiều rộng và chiều cao", () => {
    const i = parseImageHeader(pngThat(1254, 800, 6));
    assert.deepEqual([i?.width, i?.height], [1254, 800]);
  });

  test("RGBA (colorType 6) có kênh alpha", () => {
    assert.equal(parseImageHeader(pngThat(4, 4, 6))?.hasAlpha, true);
  });

  test("RGB (colorType 2) KHÔNG có kênh alpha", () => {
    assert.equal(parseImageHeader(pngThat(4, 4, 2))?.hasAlpha, false);
  });

  test("ảnh bảng màu có tRNS thì vẫn tính là có alpha", () => {
    // Trường hợp dễ bỏ sót nhất: colorType 3 không nói gì về alpha,
    // thông tin nằm ở chunk tRNS đứng trước IDAT.
    assert.equal(parseImageHeader(pngThat(4, 4, 3, true))?.hasAlpha, true);
    assert.equal(parseImageHeader(pngThat(4, 4, 3, false))?.hasAlpha, false);
  });
});

describe("parseImageHeader — WebP", () => {
  function riff(fourcc: string, body: Buffer): Buffer {
    const head = Buffer.alloc(12);
    head.write("RIFF", 0, "latin1");
    head.writeUInt32LE(4 + 8 + body.length, 4);
    head.write("WEBP", 8, "latin1");
    const ch = Buffer.alloc(8);
    ch.write(fourcc, 0, "latin1");
    ch.writeUInt32LE(body.length, 4);
    return Buffer.concat([head, ch, body]);
  }

  test("VP8X đọc kích thước canvas và cờ alpha", () => {
    const body = Buffer.alloc(10);
    body[0] = 0x10; // cờ ALPHA
    body.writeUIntLE(1536 - 1, 4, 3);
    body.writeUIntLE(1024 - 1, 7, 3);
    const i = parseImageHeader(riff("VP8X", body));
    assert.deepEqual([i?.width, i?.height, i?.hasAlpha], [1536, 1024, true]);
  });

  test("VP8L đọc kích thước gói trong 14 bit", () => {
    const body = Buffer.alloc(20);
    body[0] = 0x2f;
    const bits = (300 - 1) | ((200 - 1) << 14) | (1 << 28);
    body.writeUInt32LE(bits >>> 0, 1);
    const i = parseImageHeader(riff("VP8L", body));
    assert.deepEqual([i?.width, i?.height, i?.hasAlpha], [300, 200, true]);
  });

  test("VP8 trần đọc được kích thước, và không có alpha", () => {
    const body = Buffer.alloc(20);
    body[3] = 0x9d;
    body[4] = 0x01;
    body[5] = 0x2a;
    body.writeUInt16LE(640, 6);
    body.writeUInt16LE(480, 8);
    const i = parseImageHeader(riff("VP8 ", body));
    assert.deepEqual([i?.width, i?.height, i?.hasAlpha], [640, 480, false]);
  });
});

describe("parseImageHeader — thứ không nhận dạng được", () => {
  test("trả null chứ KHÔNG đoán bừa", () => {
    // Quan trọng: đoán bừa ở đây nghĩa là ghi một con số sai vào
    // metadata mà không ai biết. Thà trả null để người gọi lùi về đặc
    // tả và ghi log.
    assert.equal(parseImageHeader(Buffer.from("khong phai anh")), null);
    assert.equal(parseImageHeader(Buffer.alloc(0)), null);
    assert.equal(parseImageHeader(Buffer.from("RIFFxxxxWEBPZZZZ")), null);
  });

  test("PNG cụt ở giữa IHDR trả null, không ném lỗi", () => {
    assert.equal(parseImageHeader(pngThat(4, 4, 6).subarray(0, 20)), null);
  });
});

describe("readImageInfo — đọc từ đĩa", () => {
  test("mở file thật và đọc đúng số đo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "imagesize-"));
    try {
      const f = join(dir, "a.png");
      await writeFile(f, pngThat(1254, 1254, 6));
      const i = await readImageInfo(f);
      assert.deepEqual([i?.width, i?.height, i?.hasAlpha], [1254, 1254, true]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
