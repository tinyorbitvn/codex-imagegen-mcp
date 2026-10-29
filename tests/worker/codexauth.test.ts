import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { refreshMayRun } from "../../src/worker/codexauth.ts";

const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
const now = Date.parse("2026-10-30T10:00:00Z");
const auth = (exp: string, lastRefresh = "2026-10-20T10:54:47Z") => ({
  tokens: { access_token: jwt({ exp: Date.parse(exp) / 1000 }) },
  last_refresh: lastRefresh,
});

describe("refreshMayRun", () => {
  // Codex 0.163 refreshes within 5 minutes of the access token's expiry, and its lock is per process.
  const guardMs = 25 * 60_000;

  test("is false while the access token has long to live", () => {
    assert.equal(refreshMayRun(auth("2026-11-09T10:00:00Z"), now, guardMs), false);
  });

  test("is true once expiry is inside the guard", () => {
    assert.equal(refreshMayRun(auth("2026-10-30T10:20:00Z"), now, guardMs), true);
  });

  test("is true when the token has already expired", () => {
    assert.equal(refreshMayRun(auth("2026-10-30T09:00:00Z"), now, guardMs), true);
  });

  test("without a readable expiry, falls back to Codex's 8-day rule, a day early", () => {
    const noExp = { tokens: { access_token: "not-a-jwt" }, last_refresh: "2026-10-23T09:00:00Z" };
    assert.equal(refreshMayRun(noExp, now, guardMs), true);
    assert.equal(refreshMayRun({ ...noExp, last_refresh: "2026-10-27T09:00:00Z" }, now, guardMs), false);
  });

  test("an unreadable or signed-out auth file cannot refresh", () => {
    assert.equal(refreshMayRun(null, now, guardMs), false);
    assert.equal(refreshMayRun({}, now, guardMs), false);
  });
});
