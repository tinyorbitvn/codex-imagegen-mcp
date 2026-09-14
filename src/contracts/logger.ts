// Structured JSON logging.
//
// *** ABSOLUTELY FORBIDDEN IN LOGS ***
//   ChatGPT access/refresh tokens, SSO/identity-provider tokens, client
//   secrets, S3 keys, full Authorization headers.
//
// Enforcement is NOT "remember not to log it": every value passes through
// `redact()` before serialization, and suspicious keys are replaced with
// "[redacted]" BY KEY NAME. If a future developer accidentally stuffs a
// whole config object into a log call, the secret still doesn't get out.

const SECRET_KEY_PATTERN =
  /(secret|token|password|passwd|credential|authorization|api[_-]?key|access[_-]?key|private)/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[too-deep]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_PATTERN.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

/**
 * Service name attached to every log line.
 *
 * Overridable rather than fixed, because a split deployment runs the same
 * image twice. Giving each one its own name is what keeps the two pods'
 * logs apart, exactly when you are tracing one job across both.
 *
 * Taken from OTEL_SERVICE_NAME so it matches the name already shown in
 * traces, so jumping between logs and traces does not mean translating
 * names first.
 */
let serviceName = process.env.OTEL_SERVICE_NAME || "codex-imagegen-mcp";

/** Sets the service name at startup, before the first log line is written. */
export function setServiceName(name: string): void {
  serviceName = name;
}

type Level = "debug" | "info" | "warn" | "error";

function emit(level: Level, message: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    service: serviceName,
    message,
    ...(redact(fields) as Record<string, unknown>),
  });
  // stderr for warn/error to separate them from the main stream when logs are aggregated.
  if (level === "error" || level === "warn") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export const log = {
  debug: (m: string, f?: Record<string, unknown>) => emit("debug", m, f),
  info: (m: string, f?: Record<string, unknown>) => emit("info", m, f),
  warn: (m: string, f?: Record<string, unknown>) => emit("warn", m, f),
  error: (m: string, f?: Record<string, unknown>) => emit("error", m, f),
};
