// Guards the one duplication in the project: the version the MCP server
// reports has to match the package the image is built from. A client that
// is told the wrong version has no way to notice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { VERSION } from "../src/version.ts";

test("the reported version matches package.json", async () => {
  const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
  const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { version: string };
  assert.equal(VERSION, pkg.version);
});
