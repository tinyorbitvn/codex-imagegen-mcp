// The MCP Streamable HTTP endpoint.
//
// Only the gateway in front of this deployment calls into here. The
// service is ClusterIP-only with no external route pointing at it, so
// nothing outside the cluster can reach it directly.
//
// User authentication and authorization already happen at that gateway
// before a request reaches here. This service does NOT re-authenticate —
// it is never exposed to the Internet, and the trust boundary sits exactly
// at the gateway.
//
// *** THIS FILE MOUNTS ROUTES, IT DOES NOT START ANYTHING ***
// It used to be a service entrypoint: it built its own express app, its
// own Redis connections and its own health routes, and called listen().
// One process can now serve MCP and run the worker at the same time, and
// two apps cannot share one port, so the app, the dependencies and the
// probes all belong to src/index.ts and arrive here as arguments.

import express from "express";
import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import {
  ImagegenError,
  log,
  toImagegenError,
  cancelImageJobSchema,
  createImageSchema,
  editImageSchema,
  getArtifactSchema,
  getImageJobSchema,
} from "../contracts/index.ts";

import type { ImagegenService } from "./service.ts";
import { VERSION } from "../version.ts";

export interface McpDeps {
  /** Already built by the caller, because the worker in the same process shares its store and queue. */
  service: ImagegenService;
}

/**
 * The principal calling the tool — the rate-limit key.
 *
 * The gateway in front of this service has already verified the caller's
 * identity and forwards it via a header. If that header is ever missing or
 * renamed, rate limiting will lump everyone into "anonymous" — that's a
 * SAFE failure (stricter), not an open one, so it's acceptable as a
 * default.
 */
function principalOf(req: Request): string {
  const h = req.headers;
  return (
    (h["x-agentgateway-principal"] as string) ||
    (h["x-jwt-sub"] as string) ||
    (h["x-user"] as string) ||
    "anonymous"
  );
}

function ok(payload: object) {
  // The SDK requires structuredContent to have an index signature; cast
  // right here in this one spot instead of loosening the return type of
  // every service function.
  const structuredContent = payload as Record<string, unknown>;
  return {
    structuredContent,
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function fail(err: unknown) {
  const e = err instanceof ImagegenError ? err : toImagegenError(err, "IMAGE_GENERATION_FAILED");
  return {
    isError: true,
    structuredContent: e.toJSON() as unknown as Record<string, unknown>,
    content: [{ type: "text" as const, text: `${e.code}: ${e.message}` }],
  };
}


/**
 * Emits notifications/progress for a tool call in flight.
 *
 * An error here must NOT break the job: the client may have closed the
 * stream while the image is still being generated. Swallowing the error
 * and logging at debug level is correct — throwing would turn an artifact
 * that already spent quota into a failed call.
 */
/**
 * The part of `extra` (the SDK's RequestHandlerExtra) that we actually
 * use.
 *
 * Declared narrow instead of importing the SDK's full type: that type has
 * a generic that changes between SDK versions, so a narrow declaration
 * means an SDK upgrade doesn't force a signature change here.
 */
type ProgressNotification = {
  method: "notifications/progress";
  params: {
    progressToken: string | number;
    progress: number;
    total?: number;
    message?: string;
  };
};

type ToolExtra = {
  signal?: AbortSignal;
  _meta?: { progressToken?: string | number };
  // Declare the EXACT shape of the notification we send, not `unknown`:
  // function parameters are contravariant, so `(n: unknown) => …` does NOT
  // accept the SDK's `(n: ServerNotification) => …` function. This narrow
  // type is one branch of the ServerNotification union, so it's
  // assignable.
  sendNotification?: (n: ProgressNotification) => Promise<void>;
};

async function sendProgress(
  extra: ToolExtra,
  progressToken: string | number,
  p: { progress: number; total?: number; message?: string },
): Promise<void> {
  try {
    await extra.sendNotification?.({
      method: "notifications/progress",
      params: { progressToken, ...p },
    });
  } catch {
    /* client disconnected — the job keeps running on the worker */
  }
}

/**
 * Runs a job and WAITS for it, reporting progress along the way.
 *
 * *** WHY THIS IS FOLDED INTO create_image/edit_image INSTEAD OF A
 * SEPARATE TOOL ***
 * A standalone `wait_for_image` tool would need its own authorization rule
 * added at the gateway — meaning every new tool is also a gateway config
 * change, and forgetting that change makes the tool silently uncallable.
 * Folding it into the existing tools keeps the tool names unchanged and
 * the authorization rules untouched.
 *
 * Progress is sent ONLY when the client supplies a progressToken (per the
 * MCP spec: a server must not emit progress unsolicited). Without a token
 * the tool still waits normally, the client just doesn't see progress.
 */
async function runAndMaybeWait(
  handle: { job_id: string; status: string },
  args: Record<string, unknown>,
  extra: ToolExtra,
  service: ImagegenService,
) {
  if (args.wait === false) return handle;

  const token = extra._meta?.progressToken;
  const timeoutSec = (args.timeout_seconds as number | undefined) ?? 300;

  const result = await service.waitForImage(
    { job_id: handle.job_id, timeout_seconds: timeoutSec },
    {
      signal: extra.signal,
      onProgress: async ({ status, elapsedMs }) => {
        if (token === undefined) return;
        await sendProgress(extra, token, {
          progress: Math.min(Math.round(elapsedMs / 1000), timeoutSec),
          total: timeoutSec,
          message: `Image ${handle.job_id}: ${status}`,
        });
      },
    },
  );
  return result;
}

function buildMcpServer(req: Request, service: ImagegenService): McpServer {
  const server = new McpServer(
    { name: "codex-imagegen-mcp", version: VERSION },
    { capabilities: { tools: {} } },
  );
  const principal = principalOf(req);

  server.registerTool(
    "create_image",
    {
      title: "Create image artifact",
      description:
        "Generates ONE image artifact for a website. By default it WAITS " +
        "until the image is done before returning (usually 30-140 seconds) " +
        "and reports progress along the way, so you do NOT need to poll. " +
        "If it times out before finishing, it returns timed_out=true — in " +
        "that case call get_image_job(job_id) to keep following it. Set " +
        "wait=false if you want the job_id right away to run several " +
        "images in parallel.\n\n" +
        "IMPORTANT for animated web graphics: if several objects will move " +
        "INDEPENDENTLY (server, firewall, cloud, storage, network ring...) " +
        "call create_image SEPARATELY for each object with " +
        "isolated_object=true. Don't ask for one combined scene — a " +
        "combined scene can't be split into layers for animation.\n\n" +
        'Prefer style.reference (e.g. "tinyorbit-cloud-v1") over copying ' +
        "the whole style description.",
      inputSchema: createImageSchema,
    },
    async (args, extra) => {
      try {
        const a = args as Record<string, unknown>;
        const handle = await service.createImage(a, principal);
        return ok(await runAndMaybeWait(handle, a, extra, service));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_image_job",
    {
      title: "Image generation job status",
      description:
        "Queries a job's status: queued, running, completed, failed, or " +
        "cancelled. When completed, includes metadata and a downloadable " +
        "artifact URL.",
      inputSchema: getImageJobSchema,
    },
    async (args) => {
      try {
        return ok(await service.getImageJob((args as { job_id: string }).job_id));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "edit_image",
    {
      title: "Edit existing artifact",
      description:
        "Applies a change to an existing artifact and saves it as a NEW " +
        "VERSION. Never overwrites the old one. Waits and reports progress " +
        "like create_image; wait=false returns the job_id right away.",
      inputSchema: editImageSchema,
    },
    async (args, extra) => {
      try {
        const a = args as Record<string, unknown>;
        const handle = await service.editImage(a, principal);
        return ok(await runAndMaybeWait(handle, a, extra, service));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_artifact",
    {
      title: "Get artifact metadata",
      description: "Returns an artifact's metadata and URL. Omit version for the latest one.",
      inputSchema: getArtifactSchema,
    },
    async (args) => {
      try {
        return ok(await service.getArtifact(args as Record<string, unknown>));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "cancel_image_job",
    {
      title: "Cancel image generation job",
      description:
        "Cancels a job that's queued or running. A job that already " +
        "completed CANNOT be cancelled and its artifact is left untouched.",
      inputSchema: cancelImageJobSchema,
    },
    async (args) => {
      try {
        return ok(await service.cancelImageJob((args as { job_id: string }).job_id));
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}

/**
 * Registers the MCP routes on an app the caller owns.
 *
 * Health and metrics are NOT here: they describe the process, not this
 * endpoint, and in ROLE=all the same two routes have to report on the
 * worker as well. src/index.ts owns them.
 */
export function mountMcp(app: express.Express, deps: McpDeps): void {
  const { service } = deps;

  // Body parsing is attached to this route only, not to the whole app:
  // /artifacts/<key> streams files and has no business buffering a body.
  const parseJson = express.json({ limit: "1mb" });

  // MCP Streamable HTTP, session-LESS mode.
  //
  // This has to be stateless: the service runs multiple replicas behind a
  // ClusterIP Service, so two requests from the same client can land on two
  // different pods. Keeping session state in RAM would break randomly. The
  // REAL state (the job) lives in Redis.
  app.post("/mcp", parseJson, async (req: Request, res: Response) => {
    try {
      const server = buildMcpServer(req, service);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log.error("failed to handle MCP request", { err });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  const noSession = (_req: Request, res: Response) =>
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed: server runs in stateless mode" },
      id: null,
    });
  app.get("/mcp", noSession);
  app.delete("/mcp", noSession);
}
