/**
 * Shared fixture testRunResult objects for report tests.
 */

import type { TestRunResult, CcClientHandle } from "../../../src/types/report.js";

/** Minimal passing TestRunResult — 0 failures */
export const PASS_RESULT: TestRunResult = {
  total: 3,
  passed: 3,
  failed: 0,
  skipped: 0,
  durationMs: 120,
  failures: [],
};

/** Single frontend-e2e failure */
export const ONE_FRONTEND_FAILURE: TestRunResult = {
  total: 1,
  passed: 0,
  failed: 1,
  skipped: 0,
  durationMs: 800,
  failures: [
    {
      testName: "renders login form",
      testFile: "src/__tests__/login.e2e.ts",
      testType: "frontend-e2e",
      rawStack:
        "Error: expected button to be visible\n  at src/login.ts:42:10\n  at runner.ts:1",
      domHtml: "<html><body><form id='login'></form></body></html>",
      screenshotPath: "/tmp/ss/login-fail.png",
      consoleEntries: [
        {
          level: "error",
          message: "401 Unauthorized",
          timestamp: "2026-05-26T00:00:00Z",
        },
      ],
      networkEntries: [
        {
          url: "https://api.example.com/auth",
          method: "POST",
          status: 401,
        },
      ],
      lastUrl: "http://localhost:3000/login",
      lastAction: 'click("button[type=submit]")',
    },
  ],
};

/** Single backend-integration failure */
export const ONE_BACKEND_FAILURE: TestRunResult = {
  total: 1,
  passed: 0,
  failed: 1,
  skipped: 0,
  durationMs: 400,
  failures: [
    {
      testName: "POST /api/users returns 201",
      testFile: "src/__tests__/users.integration.ts",
      testType: "backend-integration",
      rawStack:
        "AssertionError: expected 201 got 500\n  at src/routes/users.ts:88:5",
      httpRequest: {
        method: "POST",
        url: "/api/users",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer secret123",
        },
        body: JSON.stringify({ name: "Alice", password: "hunter2" }),
      },
      httpResponse: {
        status: 500,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "Internal Server Error" }),
      },
      dbRows: { users: [{ id: 1, name: "Alice" }] },
    },
  ],
};

/** Multiple failures (2 frontend + 1 backend) */
export const THREE_FAILURES: TestRunResult = {
  total: 3,
  passed: 0,
  failed: 3,
  skipped: 0,
  durationMs: 1200,
  failures: [
    {
      testName: "renders dashboard",
      testFile: "src/__tests__/dashboard.e2e.ts",
      testType: "frontend-e2e",
      rawStack: "Error: expected title to be visible\n  at src/dashboard.ts:10:5",
    },
    {
      testName: "renders sidebar",
      testFile: "src/__tests__/sidebar.e2e.ts",
      testType: "frontend-e2e",
      rawStack: "Error: expected sidebar to be visible\n  at src/sidebar.ts:20:5",
    },
    {
      testName: "GET /api/products returns 200",
      testFile: "src/__tests__/products.test.ts",
      testType: "backend-integration",
      rawStack: "AssertionError: expected 200 got 404\n  at src/api/products.ts:5:3",
    },
  ],
};

/** cc stub factory — returns controlled JSON strings */
export function makeCcStub(
  confidence: number,
  patch?: string,
  relatedFiles: string[] = [],
): CcClientHandle {
  return {
    invoke: async (_prompt: string) =>
      JSON.stringify({
        confidence: confidence * 10, // 0–10 raw scale
        patch: patch ?? null,
        relatedFiles,
      }),
  };
}

/** cc stub that always throws */
export const THROWING_CC_STUB: CcClientHandle = {
  invoke: async () => {
    throw new Error("subprocess crashed");
  },
};

/** cc stub that never resolves (simulates timeout) */
export const HANGING_CC_STUB: CcClientHandle = {
  invoke: () => new Promise<string>(() => { /* never resolves */ }),
};

/** cc stub that returns unparseable output */
export const UNPARSEABLE_CC_STUB: CcClientHandle = {
  invoke: async () => "not valid json at all!!!",
};

/** Default cc stub (confidence=0.8) */
export const DEFAULT_CC_STUB = makeCcStub(0.8, "--- a/login.ts\n+++ b/login.ts\n");
