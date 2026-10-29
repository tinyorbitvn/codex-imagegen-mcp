// What the server accepts from a client's image, and what it hands Codex.

import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";

import { ImagegenError, MAX_INLINE_UPLOAD_BYTES, MAX_UPLOAD_BYTES } from "../src/contracts/index.ts";
import { decodeInlineUpload, inspectUpload, normaliseUpload } from "../src/uploads.ts";

const refused = (pattern: RegExp) => (e: unknown) =>
  e instanceof ImagegenError && e.code === "UNSUPPORTED_FORMAT" && pattern.test(e.message);

function solid(width: number, height: number) {
  return sharp({ create: { width, height, channels: 4, background: { r: 10, g: 120, b: 200, alpha: 1 } } });
}

test("PNG, JPEG and WebP are accepted with their size and alpha", async () => {
  const png = await solid(64, 32).png().toBuffer();
  assert.deepEqual(await inspectUpload(png), {
    format: "png", width: 64, height: 32, hasAlpha: true, bytes: png.byteLength,
  });
  const jpeg = await inspectUpload(await solid(40, 30).jpeg().toBuffer());
  assert.equal(jpeg.format, "jpeg");
  assert.equal(jpeg.hasAlpha, false);
  assert.equal((await inspectUpload(await solid(20, 20).webp().toBuffer())).format, "webp");
});

test("an EXIF-rotated photo reports the size it is shown at", async () => {
  const sideways = await solid(40, 20).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const info = await inspectUpload(sideways);
  assert.equal(info.width, 20);
  assert.equal(info.height, 40);
});

test("GIF, SVG and bytes that are not an image are refused by format", async () => {
  await assert.rejects(inspectUpload(await solid(20, 20).gif().toBuffer()), refused(/is gif/));
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>');
  await assert.rejects(inspectUpload(svg), refused(/is svg/));
  await assert.rejects(inspectUpload(Buffer.from("hello")), refused(/not an image/));
  await assert.rejects(inspectUpload(Buffer.alloc(0)), refused(/empty/));
});

test("an animated WebP is refused", async () => {
  // Two different frames: the encoder merges identical ones into a still.
  const strip = Buffer.alloc(20 * 40 * 4, 200);
  strip.fill(50, 20 * 20 * 4);
  const animated = await sharp(strip, { raw: { width: 20, height: 40, channels: 4, pageHeight: 20 } })
    .webp()
    .toBuffer();
  await assert.rejects(inspectUpload(animated), refused(/animated/));
});

test("sides outside 16-4096 px and files over 20 MB are refused", async () => {
  await assert.rejects(inspectUpload(await solid(4097, 16).png().toBuffer()), refused(/4096/));
  await assert.rejects(inspectUpload(await solid(15, 15).png().toBuffer()), refused(/at least 16/));
  await assert.rejects(inspectUpload(Buffer.alloc(MAX_UPLOAD_BYTES + 1)), refused(/limit is 20 MB/));
});

test("normalising turns the image upright and drops its metadata", async () => {
  const sideways = await solid(40, 20).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const out = await sharp(await normaliseUpload(sideways, "png")).metadata();
  assert.equal(out.format, "png");
  assert.equal(out.width, 20);
  assert.equal(out.height, 40);
  assert.equal(out.orientation, undefined);
  assert.equal(out.exif, undefined);
});

test("inline data is read from raw base64 or a data URI", () => {
  const bytes = Buffer.from([1, 2, 3, 250]);
  assert.deepEqual(decodeInlineUpload(bytes.toString("base64")), bytes);
  assert.deepEqual(decodeInlineUpload(`data:image/png;base64,${bytes.toString("base64")}`), bytes);
  assert.deepEqual(decodeInlineUpload(` ${bytes.toString("base64")}\n`), bytes);
});

test("inline data that is not base64, empty, or over 700 KB is refused", () => {
  assert.throws(() => decodeInlineUpload("not base64!!"), refused(/base64/));
  assert.throws(() => decodeInlineUpload(""), refused(/base64/));
  const big = Buffer.alloc(MAX_INLINE_UPLOAD_BYTES + 1).toString("base64");
  assert.throws(() => decodeInlineUpload(big), refused(/700 KB/));
});
