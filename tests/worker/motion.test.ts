// The shape of every motion, checked without rendering a single pixel.
// A loop that does not close shows as a visible jump once per cycle.

import { test } from "node:test";
import assert from "node:assert/strict";

import { ANIMATION_INTENSITIES, ANIMATION_MOTIONS } from "../../src/contracts/index.ts";
import type { AnimationMotion } from "../../src/contracts/index.ts";
import { canvasSize, frameCount, frameTransforms, transformAt } from "../../src/worker/motion.ts";
import type { FrameTransform } from "../../src/worker/motion.ts";

const EPS = 1e-9;
const near = (a: number, b: number) => Math.abs(a - b) < EPS;
/** Angle difference on the circle, so 360° and -1e-15° both count as 0°. */
const angleDiff = (a: number, b: number) => Math.abs(((((b - a) % 360) + 540) % 360) - 180);

function peak(motion: AnimationMotion, f: FrameTransform): number {
  switch (motion) {
    case "pulse": return f.scaleX - 1;
    case "shake": return Math.abs(f.angleDeg);
    case "bounce": return -f.dy;
    case "float": return Math.abs(f.dy);
    default: return 0;
  }
}

test("spin, pulse, shake and float start at the resting pose", () => {
  for (const m of ["spin", "pulse", "shake", "float"] as const) {
    const f = transformAt(m, "medium", 0);
    assert.ok(near(f.angleDeg, 0) && near(f.scaleX, 1) && near(f.scaleY, 1), m);
    assert.ok(near(f.dx, 0) && near(f.dy, 0), m);
  }
});

test("bounce starts on the ground, squashed, with its base pinned", () => {
  const f = transformAt("bounce", "medium", 0);
  assert.ok(f.scaleY < 1 && f.scaleX > 1, "squashed on landing");
  assert.ok(near(f.dy, (1 - f.scaleY) / 2), "shifted down by half the lost height");
  assert.equal(f.angleDeg, 0);
  const apex = transformAt("bounce", "medium", 0.5);
  assert.ok(near(apex.dy, -0.14) && near(apex.scaleY, 1), "apex is 14% up, unsquashed");
});

test("every motion closes its loop at every intensity", () => {
  for (const m of ANIMATION_MOTIONS) {
    for (const i of ANIMATION_INTENSITIES) {
      const a = transformAt(m, i, 0);
      const b = transformAt(m, i, 1);
      assert.ok(angleDiff(a.angleDeg, b.angleDeg) < EPS, `${m}/${i} angle`);
      assert.ok(near(a.scaleX, b.scaleX) && near(a.scaleY, b.scaleY), `${m}/${i} scale`);
      assert.ok(near(a.dx, b.dx) && near(a.dy, b.dy), `${m}/${i} offset`);
    }
  }
});

test("peak amplitude grows from low to high", () => {
  for (const m of ["pulse", "shake", "bounce", "float"] as const) {
    const peaks = ANIMATION_INTENSITIES.map((i) =>
      Math.max(...frameTransforms(m, i, 96).map((f) => peak(m, f))),
    );
    assert.ok(peaks[0]! < peaks[1]! && peaks[1]! < peaks[2]!, `${m}: ${peaks.join(" < ")}`);
  }
});

test("spin covers a full turn in even steps", () => {
  const fs = frameTransforms("spin", "medium", 24);
  assert.equal(fs.length, 24);
  fs.forEach((f, i) => assert.ok(near(f.angleDeg, i * 15), `frame ${i}`));
});

test("frameCount follows 24 fps and stays within 8-96", () => {
  assert.equal(frameCount(1000), 24);
  assert.equal(frameCount(1200), 29);
  assert.equal(frameCount(100), 8);
  assert.equal(frameCount(10_000), 96);
});

test("canvasSize fits a square spun to 45 degrees", () => {
  const c = canvasSize(100, 100, [transformAt("spin", "medium", 0.125)]);
  assert.ok(c.width >= Math.ceil(100 * Math.SQRT2), `width ${c.width}`);
  assert.ok(c.height >= Math.ceil(100 * Math.SQRT2), `height ${c.height}`);
});

test("canvasSize leaves room for vertical travel and nothing more sideways", () => {
  const c = canvasSize(100, 100, frameTransforms("float", "high", 48));
  assert.ok(c.height >= 100 + 2 * 8, `height ${c.height}`);
  assert.ok(c.width < c.height);
});
