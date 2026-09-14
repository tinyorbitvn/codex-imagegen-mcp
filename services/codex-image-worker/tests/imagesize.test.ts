// Reads image dimensions from the header.
//
// The PNGs in this test are BUILT FOR REAL using zlib (with a valid
// IDAT), not fake headers, so the parser is tested against exactly what
// it will encounter at runtime.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseImageHeader, readImageInfo } from "../src/imagesize.ts";

/** Builds a minimal valid PNG. colorType: 2=RGB, 6=RGBA, 3=palette. */
function pngThat(width: number, height: number, colorType: number, withTrns = false): Buffer {
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]!;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;

  // Each row: 1 filter byte + width*channels data bytes.
  const raw = Buffer.alloc(height * (1 + width * channels));
  const idat = deflateSync(raw);

  const chunks: Buffer[] = [chunk("IHDR", ihdr)];
  if (colorType === 3) chunks.push(chunk("PLTE", Buffer.alloc(3)));
  if (withTrns) chunks.push(chunk("tRNS", Buffer.from([0])));
  chunks.push(chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0)));

  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks]);
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  // The reader doesn't check the CRC, but leaving it at 0 still keeps the
  // file's chunk-chain structure valid — which is what the tRNS-lookup
  // function actually follows.
  return Buffer.concat([len, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
}

describe("parseImageHeader — PNG", () => {
  test("reads width and height correctly", () => {
    const i = parseImageHeader(pngThat(1254, 800, 6));
    assert.deepEqual([i?.width, i?.height], [1254, 800]);
  });

  test("RGBA (colorType 6) has an alpha channel", () => {
    assert.equal(parseImageHeader(pngThat(4, 4, 6))?.hasAlpha, true);
  });

  test("RGB (colorType 2) has NO alpha channel", () => {
    assert.equal(parseImageHeader(pngThat(4, 4, 2))?.hasAlpha, false);
  });

  test("a palette image with tRNS still counts as having alpha", () => {
    // The easiest case to miss: colorType 3 says nothing about alpha on
    // its own, the information lives in the tRNS chunk preceding IDAT.
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

  test("VP8X reads canvas dimensions and the alpha flag", () => {
    const body = Buffer.alloc(10);
    body[0] = 0x10; // ALPHA flag
    body.writeUIntLE(1536 - 1, 4, 3);
    body.writeUIntLE(1024 - 1, 7, 3);
    const i = parseImageHeader(riff("VP8X", body));
    assert.deepEqual([i?.width, i?.height, i?.hasAlpha], [1536, 1024, true]);
  });

  test("VP8L reads dimensions packed into 14 bits", () => {
    const body = Buffer.alloc(20);
    body[0] = 0x2f;
    const bits = (300 - 1) | ((200 - 1) << 14) | (1 << 28);
    body.writeUInt32LE(bits >>> 0, 1);
    const i = parseImageHeader(riff("VP8L", body));
    assert.deepEqual([i?.width, i?.height, i?.hasAlpha], [300, 200, true]);
  });

  test("bare VP8 reads dimensions, and has no alpha", () => {
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

describe("parseImageHeader — unrecognized content", () => {
  test("returns null instead of guessing wildly", () => {
    // Important: guessing here would mean writing a wrong number into
    // metadata without anyone knowing. Better to return null and let the
    // caller fall back to the spec and log it.
    assert.equal(parseImageHeader(Buffer.from("not an image")), null);
    assert.equal(parseImageHeader(Buffer.alloc(0)), null);
    assert.equal(parseImageHeader(Buffer.from("RIFFxxxxWEBPZZZZ")), null);
  });

  test("a PNG truncated mid-IHDR returns null, doesn't throw", () => {
    assert.equal(parseImageHeader(pngThat(4, 4, 6).subarray(0, 20)), null);
  });
});

describe("readImageInfo — reads from disk", () => {
  test("opens a real file and reads the correct dimensions", async () => {
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
