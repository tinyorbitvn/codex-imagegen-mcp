import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { STYLE_PROFILES, listStyleProfiles, resolveStyle } from "../../src/contracts/styles.ts";

describe("style profile", () => {
  test("the tinyorbit-cloud-v1 profile is present", () => {
    assert.ok(STYLE_PROFILES["tinyorbit-cloud-v1"]);
    assert.deepEqual(listStyleProfiles(), ["tinyorbit-cloud-v1"]);
  });

  test("the profile carries the full palette and the web-artifact constraints", () => {
    // This is the brand identity — a wrong color means an off-brand
    // artifact that nobody notices until it's composited onto the page.
    const p = STYLE_PROFILES["tinyorbit-cloud-v1"]!.prompt;
    for (const token of ["#000055", "#2E5BFF", "#CFE3FF", "#FFFFFF", "#46C3D8"]) {
      assert.match(p, new RegExp(token), `missing color ${token}`);
    }
    assert.match(p, /claymorphism/);
    assert.match(p, /transparent background/);
    assert.match(p, /12% minimum safe padding/);
  });

  test("resolveStyle: the profile comes BEFORE the extra instructions", () => {
    // Order matters: a single request fine-tunes the profile, rather than
    // being overridden by it.
    const r = resolveStyle("tinyorbit-cloud-v1", "add a blue rim light");
    const iProfile = r.prompt.indexOf("claymorphism");
    const iExtra = r.prompt.indexOf("add a blue rim light");
    assert.ok(iProfile >= 0 && iExtra > iProfile, "the profile must come first");
    assert.equal(r.reference, "tinyorbit-cloud-v1");
  });

  test("with no profile, only the extra instructions remain", () => {
    const r = resolveStyle(undefined, "free-form instructions");
    assert.equal(r.prompt, "free-form instructions");
    assert.equal(r.reference, null);
  });

  test("with nothing at all, returns an empty string instead of throwing", () => {
    const r = resolveStyle(undefined, undefined);
    assert.equal(r.prompt, "");
    assert.equal(r.reference, null);
  });

  test("a nonexistent profile throws an error that NAMES the valid ones", () => {
    // The message must be actionable: the caller needs to know what to type instead.
    assert.throws(
      () => resolveStyle("does-not-exist", undefined),
      (e: unknown) => e instanceof Error && /tinyorbit-cloud-v1/.test(e.message),
    );
  });
});
