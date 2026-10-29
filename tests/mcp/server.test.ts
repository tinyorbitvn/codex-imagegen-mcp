// tools/list over the real /mcp route: the tool names and schemas a client
// (and the gateway's allowlist) actually sees. A tool that is coded but
// not registered only shows up here.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import sharp from "sharp";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ANIMATION_MOTIONS, PUBLIC_TOOLS } from "../../src/contracts/index.ts";
import { InMemoryJobQueue, InMemoryJobStore } from "../../src/queue/index.ts";
import { ImagegenService } from "../../src/mcp/service.ts";
import { mountMcp } from "../../src/mcp/server.ts";
import { LocalArtifactStore } from "../../src/storage/index.ts";

interface ListedTool {
  name: string;
  inputSchema: { properties: Record<string, { enum?: string[] }>; required?: string[] };
}

let server: Server;
let root: string;
let base: string;

before(async () => {
  const app = express();
  root = await mkdtemp(join(tmpdir(), "mcp-route-test-"));
  const service = new ImagegenService({
    store: new InMemoryJobStore(),
    queue: new InMemoryJobQueue(),
    storage: new LocalArtifactStore({ dir: root, publicBaseUrl: "http://localhost:8080" }),
    config: { rateLimit: { createImagePerHour: 0, editImagePerHour: 0 }, uploadRetentionDays: 1 },
  });
  mountMcp(app, { service });
  server = app.listen(0);
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await rm(root, { recursive: true, force: true });
});

async function listTools(): Promise<ListedTool[]> {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(res.status, 200);
  // Stateless Streamable HTTP answers as one SSE event.
  const data = (await res.text()).split("\n").find((l) => l.startsWith("data: "));
  assert.ok(data, "an SSE data line");
  return JSON.parse(data.slice("data: ".length)).result.tools as ListedTool[];
}

test("tools/list exposes exactly the public tools", async () => {
  const names = (await listTools()).map((t) => t.name).sort();
  assert.deepEqual(names, [...PUBLIC_TOOLS].sort());
});

test("animate_image requires motion and lists the five presets", async () => {
  const tool = (await listTools()).find((t) => t.name === "animate_image");
  assert.ok(tool, "animate_image is registered");
  for (const field of ["project_id", "asset_id", "motion"]) {
    assert.ok(tool.inputSchema.required?.includes(field), `${field} is required`);
  }
  assert.deepEqual(tool.inputSchema.properties.motion?.enum, [...ANIMATION_MOTIONS]);
});

async function callTool(name: string, args: Record<string, unknown>) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }),
  });
  assert.equal(res.status, 200);
  const data = (await res.text()).split("\n").find((l) => l.startsWith("data: "));
  assert.ok(data, "an SSE data line");
  return JSON.parse(data.slice("data: ".length)).result as { content: { text: string }[]; isError?: boolean };
}

test("upload_image takes an image type or inline data, and needs a project", async () => {
  const tool = (await listTools()).find((t) => t.name === "upload_image");
  assert.ok(tool, "upload_image is registered");
  assert.deepEqual(tool.inputSchema.required, ["project_id"]);
  assert.deepEqual(tool.inputSchema.properties.content_type?.enum, ["image/png", "image/jpeg", "image/webp"]);
  assert.ok("data_base64" in tool.inputSchema.properties);
});

test("the tools that consume an upload accept its id", async () => {
  const tools = await listTools();
  const props = (n: string) => tools.find((t) => t.name === n)!.inputSchema.properties;
  assert.ok("reference_upload_ids" in props("create_image"));
  assert.ok("source_upload_id" in props("edit_image"));
  assert.ok("source_upload_id" in props("animate_image"));
});

test("upload_image explains the POST: fields first, the file last", async () => {
  const listed = (await listTools()) as unknown as { name: string; description: string }[];
  const d = listed.find((t) => t.name === "upload_image")!.description;
  assert.match(d, /multipart\/form-data/);
  assert.match(d, /fields.*first/i);
  assert.match(d, /file last|last.*file/i);
  assert.match(d, /204/);
});

test("an inline upload over the real route comes back stored", async () => {
  const png = await sharp({ create: { width: 20, height: 20, channels: 4, background: "#36c" } }).png().toBuffer();
  const r = await callTool("upload_image", { project_id: "p", data_base64: png.toString("base64") });
  assert.notEqual(r.isError, true);
  const body = JSON.parse(r.content[0]!.text) as { status: string; upload_id: string };
  assert.equal(body.status, "stored");
  assert.match(body.upload_id, /^upl_[0-9a-f]{32}$/);
});
