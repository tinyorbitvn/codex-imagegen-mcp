// imagegen-mcp — MCP Streamable HTTP NỘI BỘ.
//
// Chỉ agentgateway gọi vào đây. Service là ClusterIP và KHÔNG có
// HTTPRoute nào trỏ tới (spec §7, §23, §30).
//
// Xác thực người dùng đã do agentgateway làm xong (mcpAuthentication +
// mcpAuthorization). Service này KHÔNG xác thực lại — nó không hề mở ra
// Internet, và ranh giới tin cậy nằm đúng ở gateway.

import express from "express";
import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import {
  ImagegenError,
  log,
  setServiceName,
  toImagegenError,
  cancelImageJobSchema,
  createImageSchema,
  editImageSchema,
  getArtifactSchema,
  getImageJobSchema,
} from "@tinyorbit/contracts";
import { RedisJobQueue, RedisJobStore } from "@tinyorbit/job-queue";

import { loadConfig } from "./config.ts";
import { ImagegenService } from "./service.ts";
import { startTelemetry } from "./telemetry.ts";

setServiceName("imagegen-mcp");
const config = loadConfig();
await startTelemetry("imagegen-mcp", config.otlpEndpoint);

const store = new RedisJobStore({ url: config.redisUrl, queueLimit: config.queueLimit });
const queue = new RedisJobQueue({ url: config.redisUrl, queueLimit: config.queueLimit });
const service = new ImagegenService({
  store,
  queue,
  config: { rateLimit: config.rateLimit },
});

/**
 * Chủ thể gọi tool — khoá của rate limit.
 *
 * agentgateway đã xác thực JWT và chuyển danh tính xuống qua header.
 * Nếu về sau agentgateway đổi tên header thì rate limit sẽ gộp mọi
 * người vào "anonymous" — đó là hỏng AN TOÀN (chặt hơn), không phải hỏng
 * hở, nên chấp nhận được làm mặc định.
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
  // SDK đòi structuredContent có index signature; ép ở đúng một chỗ này
  // thay vì nới lỏng kiểu trả về của mọi hàm service.
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
 * Phát notifications/progress cho lời gọi tool đang chạy.
 *
 * Lỗi ở đây KHÔNG được làm hỏng job: client có thể đã đóng stream trong
 * khi ảnh vẫn đang sinh. Nuốt lỗi và ghi log mức debug là đúng — ném ra
 * sẽ biến một artifact đã trả tiền quota thành một lời gọi thất bại.
 */
/**
 * Phần của `extra` (RequestHandlerExtra của SDK) mà ta thật sự dùng.
 *
 * Khai hẹp thay vì import nguyên kiểu của SDK: kiểu đó có generic thay đổi
 * giữa các bản SDK, khai hẹp thì nâng SDK không kéo theo sửa chữ ký ở đây.
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
  // Khai ĐÚNG hình dạng notification ta gửi, không dùng `unknown`: tham số
  // hàm là contravariant, nên `(n: unknown) => …` KHÔNG nhận được hàm
  // `(n: ServerNotification) => …` của SDK. Kiểu hẹp này là một nhánh của
  // union ServerNotification nên gán được.
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
    /* client đã ngắt — job vẫn chạy tiếp ở worker */
  }
}

/**
 * Chạy một job rồi CHỜ, vừa chờ vừa báo tiến độ.
 *
 * *** VÌ SAO GẮN VÀO create_image/edit_image THAY VÌ LÀM TOOL RIÊNG ***
 * Một tool `wait_for_image` riêng sẽ phải thêm vào CEL rule trong
 * mcpAuthorization — tức mỗi lần thêm tool là một lần sửa cấu hình
 * agentgateway, và quên sửa thì tool im lặng không gọi được. Gắn vào tool
 * sẵn có thì tên tool không đổi, luật uỷ quyền giữ nguyên.
 *
 * Progress CHỈ gửi khi client có đưa progressToken (đúng đặc tả MCP: server
 * không được tự phát progress khi không ai xin). Không có token thì tool
 * vẫn chờ bình thường, chỉ là client không thấy tiến độ.
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
          message: `Ảnh ${handle.job_id}: ${status}`,
        });
      },
    },
  );
  return result;
}

function buildMcpServer(req: Request): McpServer {
  const server = new McpServer(
    { name: "tinyorbit-imagegen", version: "0.2.0" },
    { capabilities: { tools: {} } },
  );
  const principal = principalOf(req);

  server.registerTool(
    "create_image",
    {
      title: "Tạo artifact ảnh",
      description:
        "Sinh MỘT artifact ảnh cho website. Mặc định CHỜ tới khi ảnh xong " +
        "rồi mới trả về (thường 30-140 giây) và báo tiến độ dọc đường, nên " +
        "KHÔNG cần tự hỏi lại. Nếu hết timeout mà chưa xong thì trả " +
        "timed_out=true — khi đó gọi get_image_job(job_id) để theo tiếp. " +
        "Đặt wait=false nếu muốn nhận job_id ngay để chạy nhiều ảnh song " +
        "song.\n\n" +
        "QUAN TRỌNG cho ảnh động trên web: nếu nhiều vật sẽ chuyển động ĐỘC " +
        "LẬP (máy chủ, tường lửa, đám mây, ổ lưu trữ, vòng mạng...) thì gọi " +
        "create_image RIÊNG cho từng vật với isolated_object=true. Đừng xin " +
        "một cảnh gộp — cảnh gộp không tách lớp được để làm animation.\n\n" +
        'Ưu tiên style.reference (ví dụ "tinyorbit-cloud-v1") thay vì chép ' +
        "cả đoạn mô tả phong cách.",
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
      title: "Trạng thái job sinh ảnh",
      description:
        "Hỏi trạng thái một job: queued, running, completed, failed hoặc " +
        "cancelled. Khi completed thì kèm metadata và URL artifact tải được.",
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
      title: "Sửa artifact đã có",
      description:
        "Áp một thay đổi lên artifact đã có và lưu thành PHIÊN BẢN MỚI. " +
        "Không bao giờ ghi đè bản cũ. Chờ và báo tiến độ như create_image; " +
        "wait=false thì trả job_id ngay.",
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
      title: "Lấy metadata artifact",
      description: "Trả metadata và URL của một artifact. Bỏ trống version = bản mới nhất.",
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
      title: "Huỷ job sinh ảnh",
      description:
        "Huỷ một job đang chờ hoặc đang chạy. Job đã hoàn tất thì KHÔNG huỷ " +
        "được và artifact vẫn giữ nguyên.",
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

const app = express();
app.use(express.json({ limit: "1mb" }));

// MCP Streamable HTTP, chế độ KHÔNG giữ phiên.
//
// Bắt buộc phải stateless ở đây: service chạy nhiều replica sau một
// Service ClusterIP, nên hai request của cùng một client có thể rơi vào
// hai pod khác nhau. Giữ phiên trong RAM sẽ hỏng ngẫu nhiên. Trạng thái
// THẬT (job) nằm ở Redis.
app.post("/mcp", async (req: Request, res: Response) => {
  try {
    const server = buildMcpServer(req);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    log.error("xử lý request MCP thất bại", { err });
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
    error: { code: -32000, message: "Method not allowed: server chạy chế độ stateless" },
    id: null,
  });
app.get("/mcp", noSession);
app.delete("/mcp", noSession);

// --- Health ----------------------------------------------------------
// live: chỉ hỏi tiến trình còn chạy không. KHÔNG kiểm phụ thuộc ngoài —
// nếu không, Redis chớp nháy sẽ khiến kubelet giết cả đàn pod cùng lúc.
app.get("/health/live", (_req, res) => {
  res.json({ status: "ok" });
});

// ready: cần Redis, vì không có Redis thì không nhận nổi việc nào.
app.get("/health/ready", async (_req, res) => {
  let redis = false;
  try {
    await store.client.ping();
    redis = true;
  } catch {
    /* để false */
  }
  res.status(redis ? 200 : 503).json({
    status: redis ? "ready" : "not-ready",
    checks: { mcp: true, redis },
  });
});

app.get("/metrics", async (_req, res) => {
  let depth = -1;
  try {
    depth = await queue.depth();
  } catch {
    /* giữ -1 để phân biệt "không đọc được" với "rỗng" */
  }
  res
    .type("text/plain; version=0.0.4")
    .send(
      [
        "# HELP imagegen_queue_depth Số việc đang chờ trong hàng đợi",
        "# TYPE imagegen_queue_depth gauge",
        `imagegen_queue_depth ${depth}`,
        "",
      ].join("\n"),
    );
});

const server = app.listen(config.port, () => {
  log.info("imagegen-mcp đang nghe", { port: config.port });
});

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    log.info("nhận tín hiệu dừng", { signal: sig });
    server.close(() => {
      void Promise.allSettled([store.close(), queue.close()]).then(() => process.exit(0));
    });
  });
}
