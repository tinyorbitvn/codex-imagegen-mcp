// The upload_image contract: ids, keys and the fields other tools accept.
// Both roles import these, so a drift here breaks a job silently.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import {
  ImagegenError,
  MAX_REFERENCE_UPLOADS,
  animateImageSchema,
  createImageSchema,
  editImageSchema,
  isUploadKey,
  newUploadId,
  uploadImageSchema,
  uploadKey,
} from "../../src/contracts/index.ts";

const notFound = (e: unknown) => e instanceof ImagegenError && e.code === "UPLOAD_NOT_FOUND";

test("upload ids are upl_ plus 32 hex characters and never repeat", () => {
  const a = newUploadId();
  assert.match(a, /^upl_[0-9a-f]{32}$/);
  assert.notEqual(a, newUploadId());
});

test("an upload key puts the project in the path", () => {
  const id = newUploadId();
  assert.equal(uploadKey("tinyorbit-cloud", id), `uploads/tinyorbit-cloud/${id}`);
  assert.equal(isUploadKey(uploadKey("p", id)), true);
  assert.equal(isUploadKey("projects/p/a/v1/artifact.png"), false);
});

test("a malformed upload id is not found rather than turned into a path", () => {
  for (const bad of ["", "../../etc/passwd", "upl_XYZ", `upl_${"a".repeat(31)}`, `upl_${"a".repeat(32)}/x`]) {
    assert.throws(() => uploadKey("p", bad), notFound, JSON.stringify(bad));
  }
});

test("upload_image takes a known image type and optional inline data", () => {
  const s = z.object(uploadImageSchema);
  assert.equal(s.safeParse({ project_id: "p", content_type: "image/png" }).success, true);
  assert.equal(s.safeParse({ project_id: "p", data_base64: "aGk=" }).success, true);
  assert.equal(s.safeParse({ project_id: "p", content_type: "image/gif" }).success, false);
  assert.equal(s.safeParse({ content_type: "image/png" }).success, false, "project_id is required");
});

test("create_image accepts 1 to 4 reference uploads", () => {
  const s = z.object(createImageSchema);
  const base = { project_id: "p", asset_id: "a", description: "d" };
  const ids = (n: number) => Array.from({ length: n }, () => newUploadId());
  assert.equal(s.safeParse({ ...base, reference_upload_ids: ids(MAX_REFERENCE_UPLOADS) }).success, true);
  assert.equal(s.safeParse({ ...base, reference_upload_ids: [] }).success, false);
  assert.equal(s.safeParse({ ...base, reference_upload_ids: ids(MAX_REFERENCE_UPLOADS + 1) }).success, false);
});

test("edit_image and animate_image accept an upload as their source", () => {
  const id = newUploadId();
  assert.equal(
    z.object(editImageSchema).safeParse({ project_id: "p", asset_id: "a", instructions: "x", source_upload_id: id }).success,
    true,
  );
  assert.equal(
    z.object(animateImageSchema).safeParse({ project_id: "p", asset_id: "a", motion: "spin", source_upload_id: id }).success,
    true,
  );
});
