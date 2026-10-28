// The renderer on real pixels: frame count, looping, alpha, and that a
// moving object never leaves the canvas.

import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";

import { ImagegenError } from "../../src/contracts/index.ts";
import { MAX_ANIMATION_SIDE, renderAnimation } from "../../src/worker/animate.ts";

function solid(width: number, height: number, alpha = true): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: alpha ? 4 : 3,
      background: alpha ? { r: 230, g: 60, b: 40, alpha: 1 } : { r: 230, g: 60, b: 40 },
    },
  })
    .png()
    .toBuffer();
}

/** Bounding box of every pixel with any opacity, on one page of an animation. */
async function alphaBox(buf: Buffer, page: number) {
  const { data, info } = await sharp(buf, { page }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = info.width, minY = info.height, maxX = -1, maxY = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * 4 + 3]! > 0) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
  }
  return { minX, minY, maxX, maxY, width: info.width, height: info.height, data };
}

test("WebP and GIF both carry every frame and loop forever", async () => {
  const out = await renderAnimation(await solid(64, 64), { motion: "pulse", intensity: "medium", durationMs: 500 });
  assert.equal(out.frames, 12);
  assert.equal(out.fps, 24);
  for (const [format, buf] of [["webp", out.webp], ["gif", out.gif]] as const) {
    const m = await sharp(buf, { animated: true }).metadata();
    assert.equal(m.format, format);
    assert.equal(m.pages, out.frames, `${format} pages`);
    assert.equal(m.loop, 0, `${format} loops forever`);
    assert.equal(m.width, out.width);
    assert.equal(m.pageHeight, out.height);
  }
});

test("the WebP keeps an alpha channel", async () => {
  const out = await renderAnimation(await solid(64, 64), { motion: "float", intensity: "low", durationMs: 400 });
  assert.equal((await sharp(out.webp, { animated: true }).metadata()).hasAlpha, true);
});

test("a square spun to 45 degrees stays fully on the canvas", async () => {
  // 667 ms -> 16 frames, so page 2 is the 45° pose: the widest a square gets.
  const out = await renderAnimation(await solid(100, 100), { motion: "spin", intensity: "medium", durationMs: 667 });
  assert.equal(out.frames, 16);
  const b = await alphaBox(out.webp, 2);
  assert.ok(b.minX > 0 && b.minY > 0, `touches the top/left edge: ${JSON.stringify({ ...b, data: undefined })}`);
  assert.ok(b.maxX < b.width - 1 && b.maxY < b.height - 1, "touches the bottom/right edge");
  assert.ok(b.maxX - b.minX + 1 >= 100 * Math.SQRT2 - 4, "the corners are really there");
});

test("an opaque source still animates on a transparent canvas", async () => {
  const out = await renderAnimation(await solid(64, 64, false), { motion: "spin", intensity: "medium", durationMs: 667 });
  const b = await alphaBox(out.webp, 2);
  assert.equal(b.data[3], 0, "the corner of the canvas is transparent");
});

test("a wide source is capped at 512 px on its long side and keeps its aspect", async () => {
  const out = await renderAnimation(await solid(1536, 864), { motion: "float", intensity: "medium", durationMs: 400 });
  const b = await alphaBox(out.webp, 0);
  const objectWidth = b.maxX - b.minX + 1;
  const objectHeight = b.maxY - b.minY + 1;
  assert.ok(Math.abs(objectWidth - MAX_ANIMATION_SIDE) <= 1, `width ${objectWidth}`);
  assert.ok(Math.abs(objectHeight - 288) <= 1, `height ${objectHeight}`);
  assert.ok(out.width <= MAX_ANIMATION_SIDE + 8);
});

test("bytes that are not an image fail with the renderer's reason", async () => {
  await assert.rejects(
    () => renderAnimation(Buffer.from("not an image"), { motion: "spin", intensity: "medium", durationMs: 1200 }),
    (e: unknown) =>
      e instanceof ImagegenError &&
      e.code === "IMAGE_GENERATION_FAILED" &&
      /^Could not render the animation: .+/.test(e.message),
  );
});
