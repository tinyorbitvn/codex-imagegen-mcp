import { test, describe } from "node:test";
import assert from "node:assert/strict";

import type { ImageSpec } from "../../src/contracts/index.ts";
import {
  buildCodexArgv,
  buildCodexEnv,
  classifyCodexFailure,
  retryHintFrom,
} from "../../src/worker/runner.ts";
import { buildCreatePrompt, buildEditPrompt, specHash } from "../../src/worker/prompt.ts";
import { artifactKey } from "../../src/worker/consumer.ts";

const spec: ImageSpec = {
  projectId: "tinyorbit-cloud",
  assetId: "homepage-hero-vps",
  description: "Three-dimensional VPS server",
  stylePrompt: "3D illustration\nclaymorphism",
  styleReference: "tinyorbit-cloud-v1",
  aspectRatio: "1:1",
  width: 1536,
  height: 1536,
  transparentBackground: true,
  outputFormat: "png",
  isolatedObject: true,
  safePaddingPercent: 12,
  filename: "artifact.png",
};

describe("buildCodexArgv", () => {
  test("the prompt is always exactly ONE argv element", () => {
    // The most important test in the whole suite: as long as the prompt
    // stays a single element, no shell syntax inside it has any effect.
    const nasty = 'draw a logo"; rm -rf / #\n$(whoami)\n`id`';
    const argv = buildCodexArgv("codex", nasty);
    assert.equal(argv.at(-1), nasty);
    assert.equal(argv.filter((a) => a === nasty).length, 1);
  });

  test("never produces an element containing shell syntax", () => {
    const argv = buildCodexArgv("codex", "x");
    assert.ok(!argv.some((a) => a === "-c" || a === "sh" || a === "bash"));
  });

  test("disables Codex's own internal sandbox (bwrap can't run in the pod)", () => {
    // The real sandbox is the container itself (drop ALL, non-root,
    // read-only rootfs). Codex's bwrap needs an unprivileged user
    // namespace, so it dies in the pod, and Codex then exits code 0
    // WITHOUT writing a file — a silent failure. See the full explanation
    // on buildCodexArgv.
    const argv = buildCodexArgv("codex", "x");
    const i = argv.indexOf("--sandbox");
    assert.ok(i > 0, "must pass --sandbox");
    assert.equal(argv[i + 1], "danger-full-access");
    // The sandbox value must NOT be the last element — the prompt is last.
    assert.notEqual(i + 1, argv.length - 1);
  });

  test("a newline in the prompt does not split into a new argument", () => {
    // Assert an INVARIANT, don't pin a magic number: a multi-line prompt
    // must produce the same element count as a one-line prompt, and still
    // land entirely in the last element. Pinning `length === 4` like the
    // old version did makes this test fail every time a new valid flag is
    // added (it really did fail when --sandbox was added), which hides
    // the thing actually being tested: "a newline doesn't split into a
    // new argument".
    const multiLine = "line 1\nline 2\nline 3";
    const argv = buildCodexArgv("codex", multiLine);
    const oneLine = buildCodexArgv("codex", "x");
    assert.equal(argv.length, oneLine.length);
    assert.equal(argv.at(-1), multiLine);
  });
});

describe("buildCodexEnv", () => {
  test("does NOT forward OPENAI_API_KEY to the child process", () => {
    // Even if the pod has this variable, Codex never sees it, so there's
    // no path for it to silently start billing through an API key.
    const env = buildCodexEnv("/home/codex/.codex", {
      OPENAI_API_KEY: "sk-not-allowed",
      PATH: "/usr/bin",
    });
    assert.equal(env.OPENAI_API_KEY, undefined);
  });

  test("does NOT forward the S3 key, the Redis password, or any other internal variable", () => {
    const env = buildCodexEnv("/home/codex/.codex", {
      AWS_ACCESS_KEY_ID: "AKIA",
      AWS_SECRET_ACCESS_KEY: "secret",
      REDIS_URL: "redis://:pw@redis:6379",
      S3_ENDPOINT: "http://rgw",
      PATH: "/usr/bin",
    });
    assert.equal(env.AWS_ACCESS_KEY_ID, undefined);
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(env.REDIS_URL, undefined);
    assert.equal(env.S3_ENDPOINT, undefined);
  });

  test("only the keys on the allowlist are present", () => {
    const env = buildCodexEnv("/home/codex/.codex", { PATH: "/usr/bin", RANDOM_VAR: "x" });
    assert.deepEqual(Object.keys(env).sort(), [
      "CODEX_HOME", "HOME", "LANG", "PATH", "TERM", "TMPDIR",
    ]);
  });
});

describe("classifyCodexFailure", () => {
  test("recognizes an expired login session", () => {
    for (const s of [
      "Error: not logged in",
      "please run codex login first",
      "HTTP 401 Unauthorized",
      "session expired, re-authenticate",
    ]) {
      assert.equal(classifyCodexFailure(s), "CODEX_NOT_AUTHENTICATED", s);
    }
  });

  test("recognizes an account that does NOT have the image-generation capability", () => {
    // Must be distinguishable from "not logged in", since the two
    // situations call for two completely different fixes.
    for (const s of [
      "image generation is not available on your plan",
      "unsupported capability: images",
      "no such tool: image_gen",
      "please upgrade your plan",
    ]) {
      assert.equal(classifyCodexFailure(s), "IMAGE_CAPABILITY_UNAVAILABLE", s);
    }
  });

  test("recognizes the ChatGPT account running out of its usage limit", () => {
    // Verbatim from a real failed job on 2026-09-18: five jobs in a row
    // died this way and every one of them was reported as the generic
    // IMAGE_GENERATION_FAILED, which sent the operator digging through
    // worker logs to find a cause Codex had already stated plainly.
    const real =
      "ERROR: You've hit your usage limit. Upgrade to Pro, visit\n" +
      "https://chatgpt.com/codex/settings/usage to purchase more credits\n" +
      "or try again at 9:02 AM.";
    for (const s of [
      real,
      "usage limit reached for this account",
      "you have exceeded your quota",
      "HTTP 429 Too Many Requests",
    ]) {
      assert.equal(classifyCodexFailure(s), "CODEX_QUOTA_EXHAUSTED", s);
    }
  });

  test("a spent quota is NOT mistaken for an account that lacks the capability", () => {
    // The real message says "Upgrade to Pro", one word away from the
    // capability branch's "upgrade your plan". The two need different
    // fixes: wait/buy credits vs. change account.
    assert.equal(
      classifyCodexFailure("You've hit your usage limit. Upgrade to Pro to continue."),
      "CODEX_QUOTA_EXHAUSTED",
    );
  });

  test("does not read a quota failure out of the prompt echoed back in stderr", () => {
    // Codex prints the whole prompt before the error, so a single loose
    // word like "quota" would classify a user's own wording as a spent
    // account quota.
    assert.equal(
      classifyCodexFailure("user\nDraw a dashboard showing disk quota and rate limit gauges"),
      "IMAGE_GENERATION_FAILED",
    );
  });

  test("falls back to a generic error when it can't tell, does NOT guess wildly", () => {
    assert.equal(classifyCodexFailure("segfault at 0x0"), "IMAGE_GENERATION_FAILED");
    assert.equal(classifyCodexFailure(""), "IMAGE_GENERATION_FAILED");
  });
});

describe("retryHintFrom", () => {
  test("pulls the retry time out of Codex's usage-limit message", () => {
    assert.equal(
      retryHintFrom("to purchase more credits or try again at 9:02 AM."),
      "at 9:02 AM",
    );
  });

  test("keeps a relative hint readable", () => {
    assert.equal(retryHintFrom("Please try again in 27 minutes"), "in 27 minutes");
  });

  test("returns null when Codex offers no hint", () => {
    assert.equal(retryHintFrom(""), null);
    assert.equal(retryHintFrom("segfault at 0x0"), null);
  });

  test("refuses anything that is not a plain time — this text is shown to callers", () => {
    // Whatever this returns crosses the MCP boundary, so it must never
    // carry a path, a URL or a token fragment out of stderr.
    assert.equal(retryHintFrom("try again at /home/codex/.codex/auth.json"), null);
    assert.equal(retryHintFrom("try again at https://chatgpt.com/codex/settings"), null);
  });
});

describe("buildCreatePrompt", () => {
  test("the output path is supplied by the worker and appears explicitly", () => {
    const p = buildCreatePrompt(spec, "/work/jobs/img_abc");
    assert.match(
      p,
      /Save the final generated asset to exactly this path: \/work\/jobs\/img_abc\/artifact\.png/,
    );
  });

  test("locks Codex's scope down, doesn't let it do anything else", () => {
    const p = buildCreatePrompt(spec, "/work/jobs/img_abc");
    assert.match(p, /Do not write any other file\./);
    assert.match(p, /Apart from that, do not read or modify anything outside that directory\./);
    // The exception is MANDATORY: without it, Codex refuses to copy back
    // the very image it just generated, then exits 0 — a silent failure
    // that burns a unit of quota.
    assert.match(p, /You may read the image-generation tool's own output directory/);
    assert.match(p, /Do not perform unrelated tasks\./);
  });

  test("isolated_object produces a request to isolate the subject — a precondition for animation", () => {
    // When several objects need to move independently, each one must be
    // its own artifact on a transparent background.
    const p = buildCreatePrompt(spec, "/d");
    assert.match(p, /isolated object: render ONLY the requested subject/);
    assert.match(p, /no neighboring objects/);

    const flat = buildCreatePrompt({ ...spec, isolatedObject: false }, "/d");
    assert.doesNotMatch(flat, /isolated object: render ONLY/);
  });

  test("a transparent background produces an alpha requirement, an opaque one doesn't", () => {
    assert.match(buildCreatePrompt(spec, "/d"), /transparent background \(alpha channel\)/);
    assert.match(
      buildCreatePrompt({ ...spec, transparentBackground: false }, "/d"),
      /opaque background/,
    );
  });

  test("embeds the already-resolved style profile, not its name", () => {
    const p = buildCreatePrompt(spec, "/d");
    assert.match(p, /Style:\n3D illustration\nclaymorphism/);
    // The profile's NAME does not go into the prompt — Codex needs the
    // content, not the identifier.
    assert.doesNotMatch(p, /tinyorbit-cloud-v1/);
  });

  test("embeds the given dimensions and safe padding", () => {
    const p = buildCreatePrompt(spec, "/d");
    assert.match(p, /1536 x 1536/);
    assert.match(p, /at least 12% safe padding/);
  });
});

describe("buildEditPrompt", () => {
  test("forbids overwriting the source image", () => {
    const p = buildEditPrompt(spec, "shrink the server", "source.png", "/work/jobs/img_def");
    assert.match(p, /Do not overwrite the source image\./);
    assert.match(p, /Source image file: \/work\/jobs\/img_def\/source\.png/);
    assert.match(
      p,
      /Save the edited artifact to exactly this path: \/work\/jobs\/img_def\/artifact\.png/,
    );
  });
});

describe("artifactKey", () => {
  test("builds the correct directory layout", () => {
    assert.equal(
      artifactKey("tinyorbit-cloud", "homepage-hero-vps", 2, "artifact.png"),
      "projects/tinyorbit-cloud/homepage-hero-vps/v2/artifact.png",
    );
  });
});

describe("specHash", () => {
  test("stable, and differs based on content", () => {
    assert.equal(specHash("a"), specHash("a"));
    assert.notEqual(specHash("a"), specHash("b"));
    assert.match(specHash("a"), /^[0-9a-f]{64}$/);
  });
});
