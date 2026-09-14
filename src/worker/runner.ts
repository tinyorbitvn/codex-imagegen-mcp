// Runs the Codex CLI as a child process.
//
// *** THREE RULES THAT MUST NEVER BE BROKEN ***
//
// 1. NEVER use a shell. `spawn` is called with `shell: false` (the
//    default) and arguments are passed as an ARGV ARRAY. Caller-supplied
//    text must stay data, never syntax, so the shape to avoid is:
//        sh -c "codex exec '$USER_PROMPT'"
//    With an argv array, a prompt containing `"; rm -rf / #` is just
//    text; no layer interprets it as syntax.
//
// 2. NEVER leak credentials. The child process's environment is BUILT
//    FROM SCRATCH from an allowlist, it does not inherit process.env.
//    That keeps the S3 key and other internal variables out of Codex's
//    process space.
//
// 3. NEVER silently fall back to OPENAI_API_KEY. That variable is not on
//    the allowlist, so even if the pod has it, Codex never sees it. This
//    allowlist IS the enforcement of that rule, not just a promise on
//    paper.

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
  /** Truncated stderr, ONLY for server-side logging. Never returned over MCP. */
  stderrTail: string;
}

/**
 * Builds argv for Codex. Kept separate so tests can check the exact
 * shape of the command without actually running it.
 */
export function buildCodexArgv(binary: string, prompt: string): string[] {
  // `exec` = Codex's non-interactive mode.
  // `--skip-git-repo-check` because the job directory isn't a git repo.
  // The prompt is the LAST element and exactly ONE element.
  //
  // *** WHY WE DISABLE CODEX'S OWN INTERNAL SANDBOX ***
  // As of 0.154, Codex generates images through an "imagegen" skill — it
  // has to RUN A COMMAND to load the skill and write the file. Codex's
  // sandbox is built on bubblewrap, and bwrap needs to create an
  // unprivileged user namespace. This pod runs with
  // `capabilities: drop: [ALL]`, `allowPrivilegeEscalation: false`,
  // `readOnlyRootFilesystem: true`, as uid 10001 — so bwrap dies:
  //   bwrap: No permissions to create a new namespace, likely because
  //   the kernel does not allow non-privileged user namespaces
  // Observed effect on 2026-09-11: Codex exits code 0 after 72 seconds,
  // says "No files were written", and the job fails for lack of an
  // artifact.png — a silent failure, the exit code tells you nothing.
  //
  // There are two ways out: (a) loosen the securityContext so bwrap can
  // run, or (b) disable the INNER sandbox and keep the OUTER one intact.
  // We chose (b): the real isolation boundary here is the container
  // itself, and it's already far tighter than bwrap. Enabling bwrap would
  // mean granting the pod more privilege — weakening the very layer
  // that's protecting it, in order to build a redundant layer inside it.
  //
  // The name `danger-full-access` only means "Codex gets full access
  // INSIDE the container": still uid 10001, still a read-only root
  // filesystem, still no capabilities, still limited to exactly the
  // environment variables in the allowlist below, and still blocked by
  // NetworkPolicy from reaching anything off the approved path.
  // Verified by hand in the pod: produced a 438KB artifact.png.
  return [binary, "exec", "--skip-git-repo-check", "--sandbox", "danger-full-access", prompt];
}

/**
 * Environment for the child process — an ALLOWLIST, not a blocklist.
 *
 * Why not inherit process.env and strip things out: every time a new
 * variable is added to the Deployment, that approach silently leaks one
 * more variable. An allowlist defaults to closed.
 */
export function buildCodexEnv(
  codexHome: string,
  parentEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    CODEX_HOME: codexHome,
    HOME: codexHome.replace(/\/\.codex$/, ""),
    PATH: parentEnv.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    // Codex reads TMPDIR to write temp files; /tmp is a writable emptyDir.
    TMPDIR: parentEnv.TMPDIR ?? "/tmp",
    LANG: "C.UTF-8",
    // Some CLIs change behavior based on TERM; force dumb so it doesn't
    // emit ANSI color codes that would pollute the JSON logs.
    TERM: "dumb",
  };
  return env;
}

/**
 * Whether Codex is already logged into ChatGPT.
 *
 * Headless login uses `codex login --device-auth` — a manual step
 * performed by the operator, see docs/codex-authentication.md.
 *
 * Checked by FILE EXISTENCE, deliberately NOT by calling the API: the
 * readiness probe runs every 15 seconds, and a real API call there would
 * mean burning ChatGPT quota just to answer a yes/no question. This check
 * is cheap, and if the token has actually expired, the next real job run
 * will fail with CODEX_NOT_AUTHENTICATED — still correct, just discovered
 * later.
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
 * Guesses an error code from Codex's stderr.
 *
 * When the logged-in ChatGPT account or session does NOT have the
 * image-generation capability, callers need an EXPLICIT capability error,
 * never a silent fall back to an OPENAI_API_KEY. To do that we first need
 * to tell three situations apart, and stderr is the only thing Codex
 * gives us to work with.
 *
 * Deliberately uses loose string matching: Codex's wording changes
 * between releases, so a wrong guess falls back to
 * IMAGE_GENERATION_FAILED — still an error, just less specific. That's a
 * safe failure. If you see a misclassified case after a Codex upgrade,
 * fix the list here and update the matching test.
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

/** Whether the Codex binary is present in the image. */
export async function isCodexAvailable(binary: string): Promise<boolean> {
  // An absolute path is checked directly; a bare name is looked up on PATH.
  const candidates = binary.includes("/")
    ? [binary]
    : (process.env.PATH ?? "").split(":").filter(Boolean).map((p) => join(p, binary));
  for (const c of candidates) {
    try {
      await access(c, constants.X_OK);
      return true;
    } catch {
      /* try the next one */
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
      // shell: false is the DEFAULT — spelled out here so a future reader
      // sees this is a deliberate choice, not an oversight.
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    let settled = false;

    child.stderr.on("data", (c: Buffer) => {
      // Keep at most the last 8KB: enough to diagnose, not enough for a
      // "chatty" Codex to blow up the worker's memory.
      stderr = (stderr + c.toString("utf8")).slice(-8192);
    });
    // stdout is deliberately discarded: the artifact is a FILE on disk,
    // not something Codex prints. Reading stdout would only add surface
    // area.
    child.stdout.resume();

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      fn();
    };

    const kill = () => {
      // SIGTERM first, SIGKILL after 5s if it's still alive: give Codex a
      // chance to clean up temp files, but don't let it hold the
      // concurrency slot forever.
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    };

    const timer = setTimeout(() => {
      kill();
      finish(() =>
        reject(new Error(`Codex exceeded ${Math.round(opts.timeoutMs / 1000)}s`)),
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
