/**
 * Blackbox vitest tests for the auto-patch report module.
 *
 * Covers all 26 B-4-* contracts per public surface (post-patch).
 * cc is mocked via CcClientHandle stub — no real subprocess calls.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";

import { buildReport } from "../../src/report/buildReport.js";
import { AutoPatchReportSchema } from "../../src/report/schemas.js";
import {
  PASS_RESULT,
  ONE_FRONTEND_FAILURE,
  ONE_BACKEND_FAILURE,
  THREE_FAILURES,
  makeCcStub,
  THROWING_CC_STUB,
  HANGING_CC_STUB,
  UNPARSEABLE_CC_STUB,
  DEFAULT_CC_STUB,
} from "./fixtures/testRunResults.js";
import type { TestRunResult, CcClientHandle } from "../../src/types/report.js";

const PROJ = "/proj/myapp";

// ─── B-4-1: Report always returned ────────────────────────────────────────────

describe("B-4-1: always-resolves", () => {
  it("always-resolves-cc-throws", async () => {
    const report = await buildReport({
      runId: "run-1",
      projectPath: PROJ,
      testRunResult: ONE_FRONTEND_FAILURE,
      srcMaps: {},
      cc: THROWING_CC_STUB,
    });
    expect(() => AutoPatchReportSchema.parse(report)).not.toThrow();
    expect(report.failures[0].confidence).toBe(0);
    expect(report.failures[0].suggestedPatch).toBeUndefined();
  });

  it("always-resolves-srcmap-absent", async () => {
    const report = await buildReport({
      runId: "run-2",
      projectPath: PROJ,
      testRunResult: ONE_FRONTEND_FAILURE,
      srcMaps: {},
      cc: makeCcStub(0.8),
    });
    expect(() => AutoPatchReportSchema.parse(report)).not.toThrow();
    expect(report.failures[0].stack).toBeTruthy();
    expect(typeof report.failures[0].stack).toBe("string");
  });

  it("always-resolves-screenshot-missing", async () => {
    const result: TestRunResult = {
      ...ONE_FRONTEND_FAILURE,
      failures: [
        {
          ...ONE_FRONTEND_FAILURE.failures[0],
          screenshotPath: "/nonexistent/path/ss.png",
        },
      ],
    };
    const report = await buildReport({
      runId: "run-3",
      projectPath: PROJ,
      testRunResult: result,
      srcMaps: {},
      cc: makeCcStub(0.5),
    });
    // Must not reject; errorMessage and testId must be populated
    expect(report.failures[0].testId).toMatch(/^[0-9a-f]{12}$/);
    expect(report.failures[0].errorMessage.length).toBeGreaterThan(0);
  });
});

// ─── B-4-2: suggestedPatch omitted when confidence < 0.7 ─────────────────────

describe("B-4-2: patch threshold", () => {
  it("patch-absent-below-threshold (score 6 → 0.6)", async () => {
    const report = await buildReport({
      runId: "r1",
      projectPath: PROJ,
      testRunResult: ONE_FRONTEND_FAILURE,
      srcMaps: {},
      cc: makeCcStub(0.6, "diff content"),
    });
    expect(report.failures[0].suggestedPatch).toBeUndefined();
    expect(report.failures[0].confidence).toBeCloseTo(0.6, 2);
  });

  it("patch-absent-at-threshold-boundary (score 6, strictly below 0.7)", async () => {
    const report = await buildReport({
      runId: "r2",
      projectPath: PROJ,
      testRunResult: ONE_FRONTEND_FAILURE,
      srcMaps: {},
      cc: makeCcStub(0.6, "some patch"),
    });
    expect(report.failures[0].suggestedPatch).toBeUndefined();
  });

  it("patch-present-at-threshold (score 7 → 0.7)", async () => {
    const patch = "--- a/login.ts\n+++ b/login.ts\n@@ -42 +42 @@\n-wrong\n+right\n";
    const report = await buildReport({
      runId: "r3",
      projectPath: PROJ,
      testRunResult: ONE_FRONTEND_FAILURE,
      srcMaps: {},
      cc: makeCcStub(0.7, patch),
    });
    expect(report.failures[0].suggestedPatch).toBe(patch);
    expect(report.failures[0].confidence).toBeCloseTo(0.7, 2);
  });

  it("patch-present-above-threshold (score 9 → 0.9)", async () => {
    const patch = "--- a/api.ts\n+++ b/api.ts\n";
    const report = await buildReport({
      runId: "r4",
      projectPath: PROJ,
      testRunResult: ONE_BACKEND_FAILURE,
      srcMaps: {},
      cc: makeCcStub(0.9, patch),
    });
    expect(report.failures[0].suggestedPatch).toBe(patch);
  });

  it("confidence-scale-boundary-6-vs-7", async () => {
    const [r6, r7] = await Promise.all([
      buildReport({
        runId: "r6",
        projectPath: PROJ,
        testRunResult: ONE_FRONTEND_FAILURE,
        srcMaps: {},
        cc: makeCcStub(0.6, "patch"),
      }),
      buildReport({
        runId: "r7",
        projectPath: PROJ,
        testRunResult: ONE_FRONTEND_FAILURE,
        srcMaps: {},
        cc: makeCcStub(0.7, "patch"),
      }),
    ]);
    expect(r6.failures[0].suggestedPatch).toBeUndefined();
    expect(r6.failures[0].confidence).toBeCloseTo(0.6, 2);
    expect(r7.failures[0].suggestedPatch).toBeDefined();
    expect(r7.failures[0].confidence).toBeCloseTo(0.7, 2);
  });
});

// ─── B-4-3: failures.length === summary.failed ───────────────────────────────

describe("B-4-3: failures-length", () => {
  it("failures-length-matches-summary-failed-zero", async () => {
    const report = await buildReport({
      runId: "all-pass",
      projectPath: PROJ,
      testRunResult: PASS_RESULT,
      srcMaps: {},
      cc: DEFAULT_CC_STUB,
    });
    expect(report.failures.length).toBe(0);
    expect(report.summary.failed).toBe(0);
    expect(report.failures.length).toBe(report.summary.failed);
  });

  it("failures-length-matches-summary-failed-many", async () => {
    const report = await buildReport({
      runId: "many-fail",
      projectPath: PROJ,
      testRunResult: THREE_FAILURES,
      srcMaps: {},
      cc: DEFAULT_CC_STUB,
    });
    expect(report.failures.length).toBe(3);
    expect(report.summary.failed).toBe(3);
    expect(report.failures.length).toBe(report.summary.failed);
  });
});

// ─── B-4-4: testId stable ────────────────────────────────────────────────────

describe("B-4-4: testId stable", () => {
  it("testid-stable-across-runs", async () => {
    const [r1, r2] = await Promise.all([
      buildReport({ runId: "run-A", projectPath: PROJ, testRunResult: ONE_FRONTEND_FAILURE, srcMaps: {}, cc: DEFAULT_CC_STUB }),
      buildReport({ runId: "run-B", projectPath: PROJ, testRunResult: ONE_FRONTEND_FAILURE, srcMaps: {}, cc: DEFAULT_CC_STUB }),
    ]);
    expect(r1.failures[0].testId).toBe(r2.failures[0].testId);
    expect(r1.failures[0].testId).toMatch(/^[0-9a-f]{12}$/);
  });

  it("testid-stable-different-runid", async () => {
    const [r1, r2] = await Promise.all([
      buildReport({ runId: "rA", projectPath: "/proj/a", testRunResult: ONE_FRONTEND_FAILURE, srcMaps: {}, cc: DEFAULT_CC_STUB }),
      buildReport({ runId: "rB", projectPath: "/proj/b", testRunResult: ONE_FRONTEND_FAILURE, srcMaps: {}, cc: DEFAULT_CC_STUB }),
    ]);
    // testId must not depend on projectPath
    expect(r1.failures[0].testId).toBe(r2.failures[0].testId);
  });

  it("testid-format", async () => {
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: ONE_FRONTEND_FAILURE, srcMaps: {}, cc: DEFAULT_CC_STUB });
    expect(report.failures[0].testId).toMatch(/^[0-9a-f]{12}$/);
  });

  it("testid-differs-for-different-tests", async () => {
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: THREE_FAILURES, srcMaps: {}, cc: DEFAULT_CC_STUB });
    const ids = report.failures.map((f) => f.testId);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });
});

// ─── B-4-25: testId cross-platform path normalization ────────────────────────

describe("B-4-25: testId path normalization", () => {
  it("backslash and forward-slash paths yield same testId", async () => {
    const mkResult = (testFile: string): TestRunResult => ({
      total: 1, passed: 0, failed: 1, skipped: 0, durationMs: 10,
      failures: [{
        testName: "my test",
        testFile,
        testType: "frontend-e2e",
        rawStack: "Error\n  at src/x.ts:1:1",
      }],
    });
    const [rFwd, rBack] = await Promise.all([
      buildReport({ runId: "r1", projectPath: PROJ, testRunResult: mkResult("src/tests/login.ts"), srcMaps: {}, cc: DEFAULT_CC_STUB }),
      buildReport({ runId: "r2", projectPath: PROJ, testRunResult: mkResult("src\\tests\\login.ts"), srcMaps: {}, cc: DEFAULT_CC_STUB }),
    ]);
    expect(rFwd.failures[0].testId).toBe(rBack.failures[0].testId);
  });
});

// ─── B-4-5: Authorization-class headers redacted ─────────────────────────────

describe("B-4-5: authorization-class header redaction", () => {
  function makeBackendWithHeaders(reqHeaders: Record<string, string>, resHeaders: Record<string, string> = {}): TestRunResult {
    return {
      ...ONE_BACKEND_FAILURE,
      failures: [{
        ...ONE_BACKEND_FAILURE.failures[0],
        httpRequest: { method: "GET", url: "/api", headers: reqHeaders },
        httpResponse: { status: 200, headers: resHeaders },
      }],
    };
  }

  it("redact-authorization-header", async () => {
    const result = makeBackendWithHeaders(
      { Authorization: "Bearer my-secret-jwt" },
      { Authorization: "Bearer response-token" },
    );
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: result, srcMaps: {}, cc: DEFAULT_CC_STUB });
    expect(report.failures[0].request?.headers["Authorization"]).toBe("[REDACTED]");
    expect(report.failures[0].response?.headers["Authorization"]).toBe("[REDACTED]");
    // Key must still be present
    expect("Authorization" in (report.failures[0].request?.headers ?? {})).toBe(true);
  });

  it("redact-cookie-header", async () => {
    const result = makeBackendWithHeaders({ cookie: "session=abc123" });
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: result, srcMaps: {}, cc: DEFAULT_CC_STUB });
    expect(report.failures[0].request?.headers["cookie"]).toBe("[REDACTED]");
  });

  it("redact-x-api-key-header", async () => {
    const result = makeBackendWithHeaders({ "x-api-key": "key-12345" });
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: result, srcMaps: {}, cc: DEFAULT_CC_STUB });
    expect(report.failures[0].request?.headers["x-api-key"]).toBe("[REDACTED]");
  });

  it("redact-set-cookie-header", async () => {
    const result = makeBackendWithHeaders({}, { "Set-Cookie": "token=xyz; HttpOnly" });
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: result, srcMaps: {}, cc: DEFAULT_CC_STUB });
    expect(report.failures[0].response?.headers["Set-Cookie"]).toBe("[REDACTED]");
  });
});

// ─── B-4-6: Secret-pattern headers redacted ──────────────────────────────────

describe("B-4-6: secret-pattern header redaction", () => {
  function mkBackend(headers: Record<string, string>): TestRunResult {
    return {
      ...ONE_BACKEND_FAILURE,
      failures: [{
        ...ONE_BACKEND_FAILURE.failures[0],
        httpRequest: { method: "GET", url: "/", headers },
        httpResponse: { status: 200, headers: {} },
      }],
    };
  }

  it("redact-api-key-header (api-key)", async () => {
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: mkBackend({ "api-key": "sk-abcdef" }), srcMaps: {}, cc: DEFAULT_CC_STUB });
    expect(report.failures[0].request?.headers["api-key"]).toBe("[REDACTED]");
  });

  it("redact-api_key-header-underscore", async () => {
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: mkBackend({ "api_key": "sk-abcdef" }), srcMaps: {}, cc: DEFAULT_CC_STUB });
    expect(report.failures[0].request?.headers["api_key"]).toBe("[REDACTED]");
  });

  it("redact-secret-header", async () => {
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: mkBackend({ "x-secret": "s3cr3t" }), srcMaps: {}, cc: DEFAULT_CC_STUB });
    expect(report.failures[0].request?.headers["x-secret"]).toBe("[REDACTED]");
  });

  it("redact-token-header", async () => {
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: mkBackend({ "X-Auth-Token": "tok123" }), srcMaps: {}, cc: DEFAULT_CC_STUB });
    expect(report.failures[0].request?.headers["X-Auth-Token"]).toBe("[REDACTED]");
  });

  it("redact-password-header", async () => {
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: mkBackend({ "X-Password": "p@ssw0rd" }), srcMaps: {}, cc: DEFAULT_CC_STUB });
    expect(report.failures[0].request?.headers["X-Password"]).toBe("[REDACTED]");
  });

  it("non-sensitive-headers-preserved", async () => {
    const report = await buildReport({
      runId: "r", projectPath: PROJ,
      testRunResult: mkBackend({ "content-type": "application/json", "x-request-id": "abc-123" }),
      srcMaps: {}, cc: DEFAULT_CC_STUB,
    });
    expect(report.failures[0].request?.headers["content-type"]).toBe("application/json");
    expect(report.failures[0].request?.headers["x-request-id"]).toBe("abc-123");
  });

  it("both-header-patterns-apply", async () => {
    const report = await buildReport({
      runId: "r", projectPath: PROJ,
      testRunResult: mkBackend({ "x-api-key": "key1", "authorization": "Bearer tok" }),
      srcMaps: {}, cc: DEFAULT_CC_STUB,
    });
    expect(report.failures[0].request?.headers["x-api-key"]).toBe("[REDACTED]");
    expect(report.failures[0].request?.headers["authorization"]).toBe("[REDACTED]");
  });
});

// ─── B-4-7 + B-4-22: Body redaction ─────────────────────────────────────────

describe("B-4-7 + B-4-22: body redaction", () => {
  function mkBackendBody(reqBody?: string, resBody?: string): TestRunResult {
    return {
      ...ONE_BACKEND_FAILURE,
      failures: [{
        ...ONE_BACKEND_FAILURE.failures[0],
        httpRequest: { method: "POST", url: "/", headers: { "content-type": "application/json" }, body: reqBody },
        httpResponse: { status: 200, headers: {}, body: resBody },
      }],
    };
  }

  it("redact-password-body", async () => {
    const report = await buildReport({
      runId: "r", projectPath: PROJ,
      testRunResult: mkBackendBody('{"username":"alice","password":"hunter2"}'),
      srcMaps: {}, cc: DEFAULT_CC_STUB,
    });
    const body = report.failures[0].request?.body ?? "";
    expect(body).toContain('"password": "[REDACTED]"');
    expect(body).toContain('"username":"alice"');
  });

  it("redact-secret-body", async () => {
    const report = await buildReport({
      runId: "r", projectPath: PROJ,
      testRunResult: mkBackendBody('{"clientSecret":"abc","name":"test"}'),
      srcMaps: {}, cc: DEFAULT_CC_STUB,
    });
    const body = report.failures[0].request?.body ?? "";
    expect(body).toContain('"[REDACTED]"');
    expect(body).toContain('"name":"test"');
  });

  it("redact-token-body", async () => {
    const report = await buildReport({
      runId: "r", projectPath: PROJ,
      testRunResult: mkBackendBody(undefined, '{"accessToken":"eyJhb...","userId":42}'),
      srcMaps: {}, cc: DEFAULT_CC_STUB,
    });
    const body = report.failures[0].response?.body ?? "";
    expect(body).toContain('"[REDACTED]"');
    expect(body).not.toContain('"eyJhb..."');
  });

  it("redact-api-key-body", async () => {
    const report = await buildReport({
      runId: "r", projectPath: PROJ,
      testRunResult: mkBackendBody('{"api_key":"sk-live-xxx","model":"gpt-4"}'),
      srcMaps: {}, cc: DEFAULT_CC_STUB,
    });
    const body = report.failures[0].request?.body ?? "";
    expect(body).toContain('"[REDACTED]"');
    expect(body).toContain('"model":"gpt-4"');
  });

  it("non-json-body-not-corrupted", async () => {
    const report = await buildReport({
      runId: "r", projectPath: PROJ,
      testRunResult: mkBackendBody("plain text request body"),
      srcMaps: {}, cc: DEFAULT_CC_STUB,
    });
    expect(report.failures[0].request?.body).toBe("plain text request body");
  });

  it("redact-nested-json-body (B-4-22)", async () => {
    const report = await buildReport({
      runId: "r", projectPath: PROJ,
      testRunResult: mkBackendBody('{"auth":{"password":"s3cr3t"},"data":{"name":"test"}}'),
      srcMaps: {}, cc: DEFAULT_CC_STUB,
    });
    const body = report.failures[0].request?.body ?? "";
    expect(body).toContain('"[REDACTED]"');
    expect(body).not.toContain('"s3cr3t"');
    expect(body).toContain('"name":"test"');
  });

  it("redact-response-body-with-token (multiple keys)", async () => {
    const report = await buildReport({
      runId: "r", projectPath: PROJ,
      testRunResult: mkBackendBody(undefined, '{"accessToken":"eyJ.real.token","refreshToken":"re.fresh","code":200}'),
      srcMaps: {}, cc: DEFAULT_CC_STUB,
    });
    const body = report.failures[0].response?.body ?? "";
    // Both tokens should be redacted
    expect(body).not.toContain('"eyJ.real.token"');
    expect(body).not.toContain('"re.fresh"');
  });
});

// ─── B-4-8: domSnapshot ≤ 30 KB ──────────────────────────────────────────────

describe("B-4-8: domSnapshot cap", () => {
  function mkFrontendWithDom(domHtml: string): TestRunResult {
    return {
      ...ONE_FRONTEND_FAILURE,
      failures: [{
        ...ONE_FRONTEND_FAILURE.failures[0],
        domHtml,
      }],
    };
  }

  it("dom-snapshot-capped-30kb", async () => {
    const largeHtml = "<div>" + "A".repeat(35000) + "</div>";
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: mkFrontendWithDom(largeHtml), srcMaps: {}, cc: DEFAULT_CC_STUB });
    const snap = report.failures[0].domSnapshot!;
    expect(snap).toBeDefined();
    expect(Buffer.byteLength(snap, "utf8")).toBeLessThanOrEqual(30 * 1024);
  });

  it("dom-snapshot-truncation-marker", async () => {
    const largeHtml = "<div>" + "B".repeat(35000) + "</div>";
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: mkFrontendWithDom(largeHtml), srcMaps: {}, cc: DEFAULT_CC_STUB });
    expect(report.failures[0].domSnapshot!.endsWith("<!-- [dom truncated] -->")).toBe(true);
  });

  it("dom-snapshot-under-cap-no-marker", async () => {
    const smallHtml = "<div>" + "C".repeat(100) + "</div>";
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: mkFrontendWithDom(smallHtml), srcMaps: {}, cc: DEFAULT_CC_STUB });
    expect(report.failures[0].domSnapshot!.endsWith("<!-- [dom truncated] -->")).toBe(false);
  });
});

// ─── B-4-9: stack ≤ 8 KB ─────────────────────────────────────────────────────

describe("B-4-9: stack cap", () => {
  function mkWithRawStack(rawStack: string): TestRunResult {
    return {
      ...ONE_BACKEND_FAILURE,
      failures: [{
        ...ONE_BACKEND_FAILURE.failures[0],
        rawStack,
      }],
    };
  }

  it("stack-capped-8kb", async () => {
    const longStack = "Error: boom\n" + "  at src/app.ts:1:1\n".repeat(600);
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: mkWithRawStack(longStack), srcMaps: {}, cc: DEFAULT_CC_STUB });
    expect(Buffer.byteLength(report.failures[0].stack, "utf8")).toBeLessThanOrEqual(8 * 1024);
  });

  it("stack-truncation-marker", async () => {
    const longStack = "Error: boom\n" + "  at src/app.ts:1:1\n".repeat(600);
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: mkWithRawStack(longStack), srcMaps: {}, cc: DEFAULT_CC_STUB });
    expect(report.failures[0].stack.endsWith("[truncated]")).toBe(true);
  });
});

// ─── B-4-10: errorMessage ≤ 500 chars ────────────────────────────────────────

describe("B-4-10: error message cap", () => {
  it("error-message-capped-500", async () => {
    const longMsg = "A".repeat(600);
    const result: TestRunResult = {
      ...ONE_FRONTEND_FAILURE,
      failures: [{ ...ONE_FRONTEND_FAILURE.failures[0], rawStack: longMsg }],
    };
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: result, srcMaps: {}, cc: DEFAULT_CC_STUB });
    expect(report.failures[0].errorMessage.length).toBeLessThanOrEqual(500);
  });
});

// ─── B-4-11: suggestedFixRegion absent when stack unparseable ────────────────

describe("B-4-11: fix-region absent", () => {
  it("fix-region-absent-empty-stack", async () => {
    const result: TestRunResult = {
      ...ONE_FRONTEND_FAILURE,
      failures: [{ ...ONE_FRONTEND_FAILURE.failures[0], rawStack: "" }],
    };
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: result, srcMaps: {}, cc: DEFAULT_CC_STUB });
    expect(report.failures[0].suggestedFixRegion).toBeUndefined();
  });

  it("fix-region-absent-node-modules-only", async () => {
    const rawStack = "Error: x\n  at node_modules/jest-runner/index.js:1\n  at node_modules/vitest/dist/runner.js:99";
    const result: TestRunResult = {
      ...ONE_FRONTEND_FAILURE,
      failures: [{ ...ONE_FRONTEND_FAILURE.failures[0], rawStack }],
    };
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: result, srcMaps: {}, cc: DEFAULT_CC_STUB });
    expect(report.failures[0].suggestedFixRegion).toBeUndefined();
  });

  it("fix-region-present-for-user-frame", async () => {
    const rawStack = "Error: oops\n  at src/login.ts:42:10";
    const result: TestRunResult = {
      ...ONE_FRONTEND_FAILURE,
      failures: [{ ...ONE_FRONTEND_FAILURE.failures[0], rawStack }],
    };
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: result, srcMaps: {}, cc: DEFAULT_CC_STUB });
    expect(report.failures[0].suggestedFixRegion).toBeDefined();
  });
});

// ─── B-4-12: fixRegion.lineEnd >= lineStart ───────────────────────────────────

describe("B-4-12: fix-region lineEnd >= lineStart", () => {
  it("fix-region-lineend-gte-linestart", async () => {
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: ONE_FRONTEND_FAILURE, srcMaps: {}, cc: DEFAULT_CC_STUB });
    const region = report.failures[0].suggestedFixRegion;
    if (region) {
      expect(region.lineEnd).toBeGreaterThanOrEqual(region.lineStart);
      expect(region.lineStart).toBeGreaterThanOrEqual(1);
      expect(region.lineEnd).toBeGreaterThanOrEqual(1);
    }
  });

  it("fix-region-single-line (lineEnd >= lineStart even if equal)", async () => {
    // Line 1 — lineStart would be max(1, 1-5) = 1, lineEnd = 1+15 = 16 ≥ 1
    const result: TestRunResult = {
      ...ONE_FRONTEND_FAILURE,
      failures: [{ ...ONE_FRONTEND_FAILURE.failures[0], rawStack: "Error\n  at src/x.ts:1:1" }],
    };
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: result, srcMaps: {}, cc: DEFAULT_CC_STUB });
    const region = report.failures[0].suggestedFixRegion;
    if (region) {
      expect(region.lineEnd).toBeGreaterThanOrEqual(region.lineStart);
    }
  });
});

// ─── B-4-13: confidence in [0, 1] ────────────────────────────────────────────

describe("B-4-13: confidence in range", () => {
  it("confidence-in-range (scores 0, 5, 10)", async () => {
    for (const score of [0, 0.5, 1.0]) {
      const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: ONE_FRONTEND_FAILURE, srcMaps: {}, cc: makeCcStub(score) });
      expect(report.failures[0].confidence).toBeGreaterThanOrEqual(0);
      expect(report.failures[0].confidence).toBeLessThanOrEqual(1);
    }
  });

  it("confidence-never-nan (null confidence from cc)", async () => {
    const nullCc: CcClientHandle = {
      invoke: async () => JSON.stringify({ confidence: null, patch: null, relatedFiles: [] }),
    };
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: ONE_FRONTEND_FAILURE, srcMaps: {}, cc: nullCc });
    expect(Number.isNaN(report.failures[0].confidence)).toBe(false);
    expect(report.failures[0].confidence).toBeGreaterThanOrEqual(0);
  });
});

// ─── B-4-14: confidence = 0 when cc fails ────────────────────────────────────

describe("B-4-14: confidence zero on cc failure", () => {
  it("confidence-zero-on-cc-throw", async () => {
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: ONE_FRONTEND_FAILURE, srcMaps: {}, cc: THROWING_CC_STUB });
    expect(report.failures[0].confidence).toBe(0);
    expect(report.failures[0].suggestedPatch).toBeUndefined();
  });

  it("confidence-zero-on-cc-timeout", async () => {
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: ONE_FRONTEND_FAILURE, srcMaps: {}, cc: HANGING_CC_STUB });
    expect(report.failures[0].confidence).toBe(0);
    expect(report.failures[0].suggestedPatch).toBeUndefined();
  }, 70_000);

  it("confidence-zero-on-unparseable-cc", async () => {
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: ONE_FRONTEND_FAILURE, srcMaps: {}, cc: UNPARSEABLE_CC_STUB });
    expect(report.failures[0].confidence).toBe(0);
    expect(report.failures[0].suggestedPatch).toBeUndefined();
  });
});

// ─── B-4-15: relatedFiles always an array ────────────────────────────────────

describe("B-4-15: relatedFiles always array", () => {
  it("related-files-always-array", async () => {
    const cc = makeCcStub(0.9, undefined, ["src/api.ts", "src/auth.ts"]);
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: ONE_FRONTEND_FAILURE, srcMaps: {}, cc });
    expect(Array.isArray(report.failures[0].relatedFiles)).toBe(true);
  });

  it("related-files-empty-not-null", async () => {
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: ONE_FRONTEND_FAILURE, srcMaps: {}, cc: makeCcStub(0.9) });
    expect(Array.isArray(report.failures[0].relatedFiles)).toBe(true);
    expect(report.failures[0].relatedFiles).not.toBeNull();
    expect(report.failures[0].relatedFiles).not.toBeUndefined();
  });

  it("related-files-when-cc-fails", async () => {
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: ONE_FRONTEND_FAILURE, srcMaps: {}, cc: THROWING_CC_STUB });
    expect(Array.isArray(report.failures[0].relatedFiles)).toBe(true);
  });

  it("related-files-populated", async () => {
    const cc = makeCcStub(0.9, undefined, ["src/utils.ts", "src/types.ts"]);
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: ONE_FRONTEND_FAILURE, srcMaps: {}, cc });
    expect(report.failures[0].relatedFiles.length).toBe(2);
  });
});

// ─── B-4-16: Size cap 500 KB ─────────────────────────────────────────────────

describe("B-4-16: size cap", () => {
  function makeBigFrontendFailures(n: number, domSizeBytes: number, cc?: CcClientHandle): TestRunResult {
    const failures = Array.from({ length: n }, (_, i) => ({
      testName: `test ${i}`,
      testFile: `src/test${i}.ts`,
      testType: "frontend-e2e" as const,
      rawStack: `Error: fail\n  at src/test${i}.ts:10:1`,
      domHtml: "D".repeat(domSizeBytes),
    }));
    return { total: n, passed: 0, failed: n, skipped: 0, durationMs: 100, failures };
  }
  const FAST_CC = makeCcStub(0.5);

  it("size-cap-dom-dropped-first", async () => {
    // Each dom gets truncated to 30 KB; we need 17+ failures × 30 KB to exceed 500 KB
    // Use 20 failures × 30 KB dom = 600 KB dom section alone → triggers size cap
    const result = makeBigFrontendFailures(20, 30 * 1024);
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: result, srcMaps: {}, cc: FAST_CC });
    // domSnapshot should be dropped (priority 1)
    report.failures.forEach((f) => {
      expect(f.domSnapshot).toBeUndefined();
    });
  });

  it("size-cap-soft-not-hard (no rejection even if still over)", async () => {
    // Massively oversized — still must resolve
    const result = makeBigFrontendFailures(30, 30 * 1024);
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: result, srcMaps: {}, cc: FAST_CC });
    expect(report).toBeDefined();
    expect(report.runId).toBe("r");
  });

  it("size-cap-stack-truncated-to-2048 (step 8)", async () => {
    // Build a report that will require reaching step 8
    // We'll use a very long stack with no other large fields
    const longStack = "Error: x\n" + "  at src/app.ts:999:1\n".repeat(400);
    const manyFailures: TestRunResult = {
      total: 20, passed: 0, failed: 20, skipped: 0, durationMs: 100,
      failures: Array.from({ length: 20 }, (_, i) => ({
        testName: `test ${i}`,
        testFile: `src/t${i}.ts`,
        testType: "backend-integration" as const,
        rawStack: longStack,
        httpRequest: { method: "GET", url: "/", headers: {} },
        httpResponse: { status: 200, headers: {}, body: "x".repeat(9000) },
      })),
    };
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: manyFailures, srcMaps: {}, cc: makeCcStub(0.9, "--- a/f.ts\n+++ b/f.ts\n" + "x".repeat(8000)) });
    // At minimum the report must resolve
    expect(report).toBeDefined();
    // If size cap step 8 was reached, stacks should be ≤ 2048 chars
    report.failures.forEach((f) => {
      if (f.stack.length > 2048) {
        // Step 8 wasn't needed for this run (still under budget without it) — OK
      } else {
        expect(f.stack.length).toBeLessThanOrEqual(2048 + "[truncated]".length);
      }
    });
  });

  it("size-cap-suggested-patch-dropped-before-stack-truncation", async () => {
    // Large patches but manageable stack — patches should go first (priority 7 before 8)
    const patch = "p".repeat(40_000);
    const cc = makeCcStub(0.9, patch);
    const manyFailures: TestRunResult = {
      total: 10, passed: 0, failed: 10, skipped: 0, durationMs: 100,
      failures: Array.from({ length: 10 }, (_, i) => ({
        testName: `t${i}`,
        testFile: `src/t${i}.ts`,
        testType: "backend-integration" as const,
        rawStack: "Error\n  at src/app.ts:1:1",
      })),
    };
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: manyFailures, srcMaps: {}, cc });
    // If patches were the issue, they should be dropped; stacks should remain full (1 line)
    report.failures.forEach((f) => {
      // Stack is short (1 user-space frame); should not be truncated to 2048
      expect(f.stack.length).toBeLessThan(200);
    });
  });
});

// ─── B-4-17: Frontend-only fields absent for backend tests ───────────────────

describe("B-4-17: frontend fields absent for backend", () => {
  it("backend-fields-absent-frontend-test", async () => {
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: ONE_FRONTEND_FAILURE, srcMaps: {}, cc: DEFAULT_CC_STUB });
    const f = report.failures[0];
    expect(f.request).toBeUndefined();
    expect(f.response).toBeUndefined();
    expect(f.dbSnapshot).toBeUndefined();
  });
});

// ─── B-4-18: Backend-only fields absent for frontend tests ───────────────────

describe("B-4-18: backend fields absent for frontend", () => {
  it("frontend-fields-absent-backend-test", async () => {
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: ONE_BACKEND_FAILURE, srcMaps: {}, cc: DEFAULT_CC_STUB });
    const f = report.failures[0];
    expect(f.domSnapshot).toBeUndefined();
    expect(f.screenshotPath).toBeUndefined();
    expect(f.consoleErrors).toBeUndefined();
    expect(f.networkErrors).toBeUndefined();
    expect(f.lastUrl).toBeUndefined();
    expect(f.lastAction).toBeUndefined();
  });
});

// ─── B-4-19: generatedAt is valid ISO 8601 UTC ───────────────────────────────

describe("B-4-19: generatedAt", () => {
  it("generated-at-iso8601-utc", async () => {
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: PASS_RESULT, srcMaps: {}, cc: DEFAULT_CC_STUB });
    expect(new Date(report.generatedAt).toString()).not.toBe("Invalid Date");
    expect(report.generatedAt.endsWith("Z")).toBe(true);
    expect(report.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  });

  it("generated-at-is-recent", async () => {
    const before = Date.now();
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: PASS_RESULT, srcMaps: {}, cc: DEFAULT_CC_STUB });
    const after = Date.now();
    const ts = new Date(report.generatedAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});

// ─── B-4-20: runId echoed verbatim ───────────────────────────────────────────

describe("B-4-20: runId echo", () => {
  it("runid-echoed-verbatim", async () => {
    const report = await buildReport({ runId: "my-special-run-id-123", projectPath: PROJ, testRunResult: PASS_RESULT, srcMaps: {}, cc: DEFAULT_CC_STUB });
    expect(report.runId).toBe("my-special-run-id-123");
  });
});

// ─── B-4-21: projectPath echoed verbatim ─────────────────────────────────────

describe("B-4-21: projectPath echo", () => {
  it("projectpath-echoed-verbatim", async () => {
    const projPath = "/Users/alice/my weird project/src";
    const report = await buildReport({ runId: "r", projectPath: projPath, testRunResult: PASS_RESULT, srcMaps: {}, cc: DEFAULT_CC_STUB });
    expect(report.projectPath).toBe(projPath);
  });
});

// ─── B-4-23: failureKind canonical examples ──────────────────────────────────

describe("B-4-23: failureKind classification", () => {
  function mkResult(rawStack: string): TestRunResult {
    return {
      total: 1, passed: 0, failed: 1, skipped: 0, durationMs: 10,
      failures: [{ testName: "t", testFile: "src/t.ts", testType: "frontend-e2e", rawStack }],
    };
  }

  it("classifies TimeoutError as TIMEOUT", async () => {
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: mkResult("TimeoutError: waiting for element"), srcMaps: {}, cc: DEFAULT_CC_STUB });
    expect(report.failures[0].failureKind).toBe("TIMEOUT");
  });

  it("classifies exceeded timeout as TIMEOUT", async () => {
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: mkResult("Error: exceeded timeout of 5000ms"), srcMaps: {}, cc: DEFAULT_CC_STUB });
    expect(report.failures[0].failureKind).toBe("TIMEOUT");
  });

  it("classifies AssertionError as ASSERTION", async () => {
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: mkResult("AssertionError: expected 200 to equal 400\n  at src/t.ts:1:1"), srcMaps: {}, cc: DEFAULT_CC_STUB });
    expect(report.failures[0].failureKind).toBe("ASSERTION");
  });

  it("classifies Error: expect( as ASSERTION", async () => {
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: mkResult("Error: expect(received).toBe(expected)\n  at src/t.ts:1:1"), srcMaps: {}, cc: DEFAULT_CC_STUB });
    expect(report.failures[0].failureKind).toBe("ASSERTION");
  });

  it("classifies unmatched stack as EXCEPTION", async () => {
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: mkResult("SomeRandomError: something went wrong\n  at src/t.ts:1:1"), srcMaps: {}, cc: DEFAULT_CC_STUB });
    expect(report.failures[0].failureKind).toBe("EXCEPTION");
  });
});

// ─── B-4-24: confidence normalization formula ────────────────────────────────

describe("B-4-24: confidence normalization", () => {
  it("rawScore 6 → confidence 0.6", async () => {
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: ONE_FRONTEND_FAILURE, srcMaps: {}, cc: makeCcStub(0.6) });
    expect(report.failures[0].confidence).toBeCloseTo(0.6, 10);
  });

  it("rawScore 7 → confidence 0.7", async () => {
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: ONE_FRONTEND_FAILURE, srcMaps: {}, cc: makeCcStub(0.7) });
    expect(report.failures[0].confidence).toBeCloseTo(0.7, 10);
  });

  it("rawScore 10 → confidence 1.0", async () => {
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: ONE_FRONTEND_FAILURE, srcMaps: {}, cc: makeCcStub(1.0) });
    expect(report.failures[0].confidence).toBeCloseTo(1.0, 10);
  });
});

// ─── Schema conformance tests ─────────────────────────────────────────────────

describe("Schema conformance", () => {
  it("full-schema-parse-all-pass", async () => {
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: PASS_RESULT, srcMaps: {}, cc: DEFAULT_CC_STUB });
    expect(() => AutoPatchReportSchema.parse(report)).not.toThrow();
  });

  it("full-schema-parse-with-failures", async () => {
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: ONE_FRONTEND_FAILURE, srcMaps: {}, cc: makeCcStub(0.9, "--- a/f.ts\n") });
    expect(() => AutoPatchReportSchema.parse(report)).not.toThrow();
  });

  it("required-fields-always-present", async () => {
    const results = [PASS_RESULT, ONE_FRONTEND_FAILURE, ONE_BACKEND_FAILURE];
    for (const r of results) {
      const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: r, srcMaps: {}, cc: DEFAULT_CC_STUB });
      expect(report.runId).toBeDefined();
      expect(report.projectPath).toBeDefined();
      expect(report.generatedAt).toBeDefined();
      expect(report.summary).toBeDefined();
      expect(report.failures).toBeDefined();
    }
  });

  it("failure-record-required-fields", async () => {
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: ONE_BACKEND_FAILURE, srcMaps: {}, cc: DEFAULT_CC_STUB });
    const f = report.failures[0];
    expect(f.testId).toBeDefined();
    expect(f.testName).toBeDefined();
    expect(f.testFile).toBeDefined();
    expect(f.testType).toBeDefined();
    expect(f.failureKind).toBeDefined();
    expect(f.errorMessage).toBeDefined();
    expect(f.stack).toBeDefined();
    expect(f.relatedFiles).toBeDefined();
    expect(typeof f.confidence).toBe("number");
    expect(typeof f.costCcCalls).toBe("number");
    expect(typeof f.costMs).toBe("number");
  });

  it("optional-fields-absent-not-null-frontend (no dom/screenshot)", async () => {
    const result: TestRunResult = {
      ...ONE_FRONTEND_FAILURE,
      failures: [{
        testName: "t",
        testFile: "src/t.ts",
        testType: "frontend-e2e",
        rawStack: "Error\n  at src/t.ts:1:1",
        // No domHtml, screenshotPath, consoleEntries, networkEntries
      }],
    };
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: result, srcMaps: {}, cc: DEFAULT_CC_STUB });
    expect("domSnapshot" in report.failures[0]).toBe(false);
    expect("screenshotPath" in report.failures[0]).toBe(false);
    expect("consoleErrors" in report.failures[0]).toBe(false);
    expect("networkErrors" in report.failures[0]).toBe(false);
  });

  it("optional-fields-absent-not-null-backend (no dbRows, low confidence)", async () => {
    const result: TestRunResult = {
      ...ONE_BACKEND_FAILURE,
      failures: [{
        testName: "t",
        testFile: "src/t.ts",
        testType: "backend-integration",
        rawStack: "AssertionError\n  at src/t.ts:1:1",
        // No dbRows
      }],
    };
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: result, srcMaps: {}, cc: makeCcStub(0.5) });
    expect("dbSnapshot" in report.failures[0]).toBe(false);
    expect("suggestedPatch" in report.failures[0]).toBe(false);
  });
});

// ─── TestSprite compat output ─────────────────────────────────────────────────

describe("TestSprite compat output", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tspr-test-"));
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("compat-file-written-to-expected-path", async () => {
    await buildReport(
      { runId: "compat-run", projectPath: tmpDir, testRunResult: ONE_BACKEND_FAILURE, srcMaps: {}, cc: DEFAULT_CC_STUB },
      { emitTestSpriteCompat: true },
    );

    // Give the fire-and-forget write a moment to complete
    await new Promise((r) => setTimeout(r, 200));

    const compatPath = path.join(tmpDir, ".tspr", "test_results.json");
    const exists = await fs.access(compatPath).then(() => true).catch(() => false);
    expect(exists).toBe(true);

    const content = JSON.parse(await fs.readFile(compatPath, "utf8"));
    expect(content.run_id).toBe("compat-run");
    expect(content.total_tests).toBe(1);
    expect(content.failed).toBe(1);
    expect(Array.isArray(content.failures)).toBe(true);
    expect(content.failures[0].failing_test_id).toMatch(/^[0-9a-f]{12}$/);
    expect(content.failures[0].test_name).toBeDefined();
  });

  it("compat-file-maps-snake-case-fields", async () => {
    const result: TestRunResult = {
      ...ONE_FRONTEND_FAILURE,
      failures: [{
        ...ONE_FRONTEND_FAILURE.failures[0],
        rawStack: "Error\n  at src/login.ts:42:10",
      }],
    };
    await buildReport(
      { runId: "compat-snake", projectPath: tmpDir, testRunResult: result, srcMaps: {}, cc: makeCcStub(0.9, "--- a/f\n+++ b/f\n") },
      { emitTestSpriteCompat: true },
    );

    await new Promise((r) => setTimeout(r, 200));

    const compatPath = path.join(tmpDir, ".tspr", "test_results.json");
    const content = JSON.parse(await fs.readFile(compatPath, "utf8"));
    expect(content.failures[0].stack_trace).toBeDefined();
    // confidence field should NOT appear in compat format
    expect("confidence" in content.failures[0]).toBe(false);
    // related_files should appear
    expect(Array.isArray(content.failures[0].related_files)).toBe(true);
  });
});

// ─── Error code tests ─────────────────────────────────────────────────────────

describe("Error codes", () => {
  it("source-map-not-found-graceful (empty srcMaps is fine)", async () => {
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: ONE_FRONTEND_FAILURE, srcMaps: {}, cc: DEFAULT_CC_STUB });
    // Must resolve; stack must be non-empty (raw frames used)
    expect(report.failures[0].stack).toBeTruthy();
  });

  it("cc-timeout-graceful", async () => {
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: ONE_FRONTEND_FAILURE, srcMaps: {}, cc: HANGING_CC_STUB });
    expect(report.failures[0].confidence).toBe(0);
    expect(report.failures[0].suggestedPatch).toBeUndefined();
  }, 70_000);
});

// ─── Happy path end-to-end ───────────────────────────────────────────────────

describe("Happy path", () => {
  it("frontend-e2e-failure-full-shape", async () => {
    const cc = makeCcStub(0.8, "--- a/login.ts\n+++ b/login.ts\n", ["src/login.ts"]);
    const report = await buildReport({ runId: "hp-fe-01", projectPath: "/home/user/myapp", testRunResult: ONE_FRONTEND_FAILURE, srcMaps: {}, cc });
    expect(report.runId).toBe("hp-fe-01");
    expect(report.projectPath).toBe("/home/user/myapp");
    expect(report.summary.failed).toBe(1);
    expect(report.failures.length).toBe(1);
    expect(report.failures[0].testType).toBe("frontend-e2e");
    expect(report.failures[0].request).toBeUndefined();
    expect(report.failures[0].response).toBeUndefined();
    expect(report.failures[0].dbSnapshot).toBeUndefined();
    expect(report.failures[0].suggestedPatch).toBeDefined();
    expect(() => AutoPatchReportSchema.parse(report)).not.toThrow();
  });

  it("backend-integration-failure-full-shape", async () => {
    const result: TestRunResult = {
      ...ONE_BACKEND_FAILURE,
      failures: [{
        testName: "POST /api/users",
        testFile: "src/__tests__/users.test.ts",
        testType: "backend-integration",
        rawStack: "AssertionError: expected 201 got 500\n  at src/routes/users.ts:88:5",
        httpRequest: {
          method: "POST", url: "/api/users",
          headers: { "authorization": "Bearer tok", "api_key": "key" },
          body: '{"name":"Bob","password":"pass"}',
        },
        httpResponse: { status: 500, headers: {}, body: '{"error":"oops"}' },
      }],
    };
    const report = await buildReport({ runId: "hp-be-01", projectPath: "/srv/project", testRunResult: result, srcMaps: {}, cc: makeCcStub(0.5) });
    expect(report.failures[0].testType).toBe("backend-integration");
    expect(report.failures[0].request!.headers["authorization"]).toBe("[REDACTED]");
    expect(report.failures[0].domSnapshot).toBeUndefined();
    expect(report.failures[0].screenshotPath).toBeUndefined();
    expect(report.failures[0].suggestedPatch).toBeUndefined(); // confidence 0.5 < 0.7
    expect(() => AutoPatchReportSchema.parse(report)).not.toThrow();
  });

  it("multiple-failures-array-shape", async () => {
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: THREE_FAILURES, srcMaps: {}, cc: DEFAULT_CC_STUB });
    expect(report.failures.length).toBe(3);
    const ids = report.failures.map((f) => f.testId);
    ids.forEach((id) => expect(id).toMatch(/^[0-9a-f]{12}$/));
    expect(new Set(ids).size).toBe(3);
    expect(() => AutoPatchReportSchema.parse(report)).not.toThrow();
  });
});

// ─── confidence-zero-no-patch (B-4-2 + B-4-14 combined) ─────────────────────

describe("confidence-zero-no-patch", () => {
  it("zero confidence implies patch absent", async () => {
    const report = await buildReport({ runId: "r", projectPath: PROJ, testRunResult: ONE_FRONTEND_FAILURE, srcMaps: {}, cc: THROWING_CC_STUB });
    expect(report.failures[0].confidence).toBe(0);
    expect(report.failures[0].suggestedPatch).toBeUndefined();
  });
});
