// Chạy Codex CLI như một tiến trình con.
//
// *** BA LUẬT KHÔNG ĐƯỢC PHÁ ***
//
// 1. KHÔNG BAO GIỜ dùng shell. `spawn` được gọi với `shell: false` (mặc
//    định) và tham số truyền bằng MẢNG argv. Dạng bị cấm tuyệt đối,
//    spec §19 nêu đích danh:
//        sh -c "codex exec '$USER_PROMPT'"
//    Với mảng argv thì một prompt chứa `"; rm -rf / #` chỉ là văn bản;
//    không có tầng nào diễn giải nó thành cú pháp.
//
// 2. KHÔNG BAO GIỜ để lộ credential. Môi trường của tiến trình con được
//    DỰNG MỚI từ danh sách cho phép, không kế thừa process.env. Nhờ vậy
//    key S3 và các biến nội bộ khác không lọt vào không gian tiến trình
//    của Codex.
//
// 3. KHÔNG BAO GIỜ tự rơi về OPENAI_API_KEY. Biến đó không có trong
//    danh sách cho phép, nên kể cả pod có nó thì Codex cũng không thấy.
//    Đây chính là cơ chế thực thi spec §16/§37, chứ không phải lời hứa.

import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { join } from "node:path";

export interface CodexRunOptions {
  binary: string;
  codexHome: string;
  prompt: string;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}

export interface CodexResult {
  exitCode: number;
  durationMs: number;
  /** stderr đã cắt ngắn, CHỈ để ghi log phía server. Không trả ra MCP. */
  stderrTail: string;
}

/**
 * Dựng argv cho Codex. Tách riêng để test kiểm được đúng hình dạng lệnh
 * mà không phải chạy thật (spec §44 "Codex command construction").
 */
export function buildCodexArgv(binary: string, prompt: string): string[] {
  // `exec` = chế độ không tương tác của Codex.
  // `--skip-git-repo-check` vì thư mục job không phải repo git.
  // Prompt là PHẦN TỬ CUỐI và là MỘT phần tử duy nhất.
  //
  // *** VÌ SAO TẮT SANDBOX NỘI BỘ CỦA CODEX ***
  // Từ 0.154, Codex sinh ảnh bằng "skill" imagegen — nó phải CHẠY LỆNH
  // để đọc skill rồi ghi file. Sandbox của Codex dựng bằng bubblewrap,
  // mà bwrap cần tạo user namespace không đặc quyền. Pod này thì
  // `capabilities: drop: [ALL]`, `allowPrivilegeEscalation: false`,
  // `readOnlyRootFilesystem: true`, chạy uid 10001 — nên bwrap chết:
  //   bwrap: No permissions to create a new namespace, likely because
  //   the kernel does not allow non-privileged user namespaces
  // Hệ quả đo được 2026-09-11: Codex thoát mã 0 sau 72 giây, nói "No
  // files were written", job failed vì không có artifact.png — hỏng câm,
  // exit code không phản ánh gì.
  //
  // Có hai đường: (a) nới securityContext để bwrap chạy được, hoặc
  // (b) tắt sandbox TRONG và giữ nguyên sandbox NGOÀI. Chọn (b): lớp
  // cách ly thật ở đây là chính container, và nó đang chặt hơn nhiều so
  // với bwrap. Bật bwrap đồng nghĩa phải cấp thêm quyền cho pod — tức
  // làm YẾU đi đúng lớp đang bảo vệ mình, để dựng một lớp thừa bên trong.
  //
  // Cái tên `danger-full-access` chỉ nói "Codex được toàn quyền TRONG
  // container": vẫn uid 10001, vẫn root filesystem chỉ đọc, vẫn không
  // capability nào, vẫn chỉ thấy đúng các biến môi trường ở allowlist
  // dưới đây, và vẫn bị NetworkPolicy chặn mọi đích ngoài luồng.
  // Đã kiểm tay trong pod: sinh được artifact.png 438KB.
  return [binary, "exec", "--skip-git-repo-check", "--sandbox", "danger-full-access", prompt];
}

/**
 * Môi trường cho tiến trình con — danh sách CHO PHÉP, không phải danh
 * sách cấm.
 *
 * Vì sao không kế thừa process.env rồi xoá bớt: mỗi lần thêm một biến
 * mới vào Deployment, cách đó lại âm thầm rò thêm một biến. Danh sách
 * cho phép thì mặc định là đóng.
 */
export function buildCodexEnv(
  codexHome: string,
  parentEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    CODEX_HOME: codexHome,
    HOME: codexHome.replace(/\/\.codex$/, ""),
    PATH: parentEnv.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    // Codex đọc TMPDIR để ghi file tạm; /tmp là emptyDir ghi được.
    TMPDIR: parentEnv.TMPDIR ?? "/tmp",
    LANG: "C.UTF-8",
    // Một số CLI đổi hành vi khi thấy TERM; ép dumb để không sinh mã màu
    // ANSI làm bẩn log JSON.
    TERM: "dumb",
  };
  return env;
}

/**
 * Codex đã đăng nhập ChatGPT chưa.
 *
 * Đăng nhập headless dùng `codex login --device-auth` (spec §15) — thao
 * tác tay của người vận hành, xem docs/mcp/codex-authentication.md.
 *
 * Kiểm bằng SỰ TỒN TẠI CỦA FILE, cố ý KHÔNG gọi API. Spec §32 cấm dùng
 * thao tác tính phí trong readiness probe, mà probe chạy 15 giây một
 * lần. Đây là kiểm rẻ, và nếu token hết hạn thì lần chạy job thật sẽ
 * fail với CODEX_NOT_AUTHENTICATED — vẫn đúng, chỉ muộn hơn.
 */
export async function isCodexAuthenticated(codexHome: string): Promise<boolean> {
  try {
    await access(join(codexHome, "auth.json"), constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Đoán mã lỗi từ stderr của Codex.
 *
 * Spec §31 đòi: nếu tài khoản/phiên ChatGPT KHÔNG có khả năng sinh ảnh
 * thì phải trả lỗi khả năng TƯỜNG MINH, tuyệt đối không âm thầm rơi về
 * OPENAI_API_KEY. Muốn làm được vậy thì trước hết phải phân biệt được
 * ba tình huống, và thứ duy nhất Codex cho ta là stderr.
 *
 * Cố ý dùng khớp chuỗi lỏng: Codex đổi câu chữ giữa các bản, nên đoán
 * sai thì rơi về IMAGE_GENERATION_FAILED — vẫn là lỗi, chỉ kém cụ thể.
 * Đó là hỏng an toàn. Nếu thấy mã đoán sai sau một lần nâng cấp Codex
 * thì sửa danh sách ở đây, và cập nhật test tương ứng.
 */
export function classifyCodexFailure(
  stderr: string,
): "CODEX_NOT_AUTHENTICATED" | "IMAGE_CAPABILITY_UNAVAILABLE" | "IMAGE_GENERATION_FAILED" {
  const s = stderr.toLowerCase();

  if (
    s.includes("not logged in") ||
    s.includes("please run codex login") ||
    s.includes("unauthorized") ||
    s.includes("401") ||
    s.includes("authentication required") ||
    s.includes("session expired") ||
    s.includes("token expired")
  ) {
    return "CODEX_NOT_AUTHENTICATED";
  }

  if (
    s.includes("not available on your plan") ||
    s.includes("image generation is not") ||
    s.includes("unsupported capability") ||
    s.includes("no such tool") ||
    s.includes("capability not enabled") ||
    s.includes("upgrade your plan")
  ) {
    return "IMAGE_CAPABILITY_UNAVAILABLE";
  }

  return "IMAGE_GENERATION_FAILED";
}

/** Binary Codex có trong image không. */
export async function isCodexAvailable(binary: string): Promise<boolean> {
  // Đường dẫn tuyệt đối thì kiểm thẳng; tên trần thì dò theo PATH.
  const candidates = binary.includes("/")
    ? [binary]
    : (process.env.PATH ?? "").split(":").filter(Boolean).map((p) => join(p, binary));
  for (const c of candidates) {
    try {
      await access(c, constants.X_OK);
      return true;
    } catch {
      /* thử tiếp */
    }
  }
  return false;
}

export function runCodex(opts: CodexRunOptions): Promise<CodexResult> {
  const started = Date.now();
  const [cmd, ...args] = buildCodexArgv(opts.binary, opts.prompt);

  return new Promise<CodexResult>((resolve, reject) => {
    const child = spawn(cmd!, args, {
      cwd: opts.cwd,
      env: buildCodexEnv(opts.codexHome),
      // shell: false là MẶC ĐỊNH — ghi ra đây cho người đọc sau thấy rõ
      // rằng đó là lựa chọn, không phải bỏ sót.
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    let settled = false;

    child.stderr.on("data", (c: Buffer) => {
      // Giữ tối đa 8KB cuối: đủ để chẩn đoán, không đủ để một Codex
      // "nói nhiều" làm phình bộ nhớ worker.
      stderr = (stderr + c.toString("utf8")).slice(-8192);
    });
    // stdout bị bỏ qua có chủ đích: artifact là FILE trên đĩa, không
    // phải thứ Codex in ra. Đọc stdout chỉ tạo thêm bề mặt.
    child.stdout.resume();

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      fn();
    };

    const kill = () => {
      // SIGTERM trước, SIGKILL sau 5s nếu còn sống: cho Codex cơ hội dọn
      // file tạm, nhưng không để nó giữ slot concurrency mãi.
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    };

    const timer = setTimeout(() => {
      kill();
      finish(() =>
        reject(new Error(`Codex vượt quá ${Math.round(opts.timeoutMs / 1000)}s`)),
      );
    }, opts.timeoutMs);

    const onAbort = () => {
      kill();
      finish(() => reject(new Error("CANCELLED")));
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (e) => finish(() => reject(e)));
    child.on("close", (code) =>
      finish(() =>
        resolve({
          exitCode: code ?? -1,
          durationMs: Date.now() - started,
          stderrTail: stderr,
        }),
      ),
    );
  });
}
