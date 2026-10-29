// Whether Codex may refresh its ChatGPT sign-in during the next run, read
// from the same auth.json Codex reads. Only the expiry claim and
// last_refresh are looked at; no token leaves this file.
//
// Why the worker cares: Codex's refresh lock is per process. Two Codex
// processes refreshing at once both spend the same refresh token, and the
// second is told "your refresh token was already used". OpenAI's guidance
// is one auth.json per serialized job stream. The consumer therefore runs
// one job at a time whenever a refresh may happen, and side by side
// otherwise.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Codex 0.163 refreshes this long before the access token expires. */
export const CODEX_REFRESH_WINDOW_MS = 5 * 60_000;

/** Codex's fallback when the token has no readable expiry is 8 days; one day early. */
const LAST_REFRESH_LIMIT_MS = 7 * 24 * 3_600_000;

export interface CodexAuthJson {
  tokens?: { access_token?: unknown };
  last_refresh?: unknown;
}

export async function readCodexAuth(codexHome: string): Promise<CodexAuthJson | null> {
  try {
    return JSON.parse(await readFile(join(codexHome, "auth.json"), "utf8")) as CodexAuthJson;
  } catch {
    return null;
  }
}

/**
 * True when Codex may refresh within `guardMs` of `nowMs`. Mirrors
 * Codex's own rule: the access token's expiry when it has one, else
 * the age of last_refresh.
 */
export function refreshMayRun(auth: CodexAuthJson | null, nowMs: number, guardMs: number): boolean {
  const token = auth?.tokens?.access_token;
  if (typeof token !== "string") return false;
  const exp = jwtExpiryMs(token);
  if (exp !== null) return exp - nowMs <= guardMs;
  const last = typeof auth?.last_refresh === "string" ? Date.parse(auth.last_refresh) : NaN;
  return Number.isFinite(last) && nowMs - last >= LAST_REFRESH_LIMIT_MS;
}

function jwtExpiryMs(token: string): number | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const exp = (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown }).exp;
    return typeof exp === "number" ? exp * 1000 : null;
  } catch {
    return null;
  }
}
