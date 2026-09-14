// Configuration comes entirely from environment variables — there is no
// config file. Whatever deploys this container (Helm, Compose, plain
// `docker run`) sets them at start time.
//
// NONE of these values point at an OpenAI API key. This service doesn't
// even touch Codex — it only pushes work onto the queue.

function str(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`${name} must be an integer, got: ${v}`);
  return n;
}

export interface Config {
  port: number;
  redisUrl: string;
  queueLimit: number;
  otlpEndpoint: string;
  rateLimit: { createImagePerHour: number; editImagePerHour: number };
}

export function loadConfig(): Config {
  return {
    port: int("PORT", 8080),
    redisUrl: str("REDIS_URL"),
    queueLimit: int("QUEUE_LIMIT", 64),
    // Empty = OTLP export fully disabled. Point this at whatever collector
    // you already run instead of standing up a new one; leaving it empty
    // is fine for local runs and tests.
    otlpEndpoint: str("OTEL_EXPORTER_OTLP_ENDPOINT", ""),
    rateLimit: {
      createImagePerHour: int("RATE_LIMIT_CREATE_IMAGE_PER_HOUR", 10),
      editImagePerHour: int("RATE_LIMIT_EDIT_IMAGE_PER_HOUR", 20),
    },
  };
}
