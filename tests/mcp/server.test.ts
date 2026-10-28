// tools/list over the real /mcp route: the tool names and schemas a client
// (and the gateway's allowlist) actually sees. A tool that is coded but
// not registered only shows up here.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { ANIMATION_MOTIONS, PUBLIC_TOOLS } from "../../src/contracts/index.ts";
import { InMemoryJobQueue, InMemoryJobStore } from "../../src/queue/index.ts";
import { ImagegenService } from "../../src/mcp/service.ts";
import { mountMcp } from "../../src/mcp/server.ts";

interface ListedTool {
  name: string;
  inputSchema: { properties: Record<string, { enum?: string[] }>; required?: string[] };
}

let server: Server;
let base: string;

before(async () => {
  const app = express();
  const service = new ImagegenService({
    store: new InMemoryJobStore(),
    queue: new InMemoryJobQueue(),
    config: { rateLimit: { createImagePerHour: 0, editImagePerHour: 0 } },
  });
  mountMcp(app, { service });
  server = app.listen(0);
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
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
