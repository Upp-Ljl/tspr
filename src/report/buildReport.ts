/**
 * src/report/buildReport.ts
 *
 * Main buildReport() orchestrator.
 *
 * Contracts: B-4-1 through B-4-26 (see public surface for details).
 */

import { createHash } from "crypto";
import type {
  AutoPatchReport,
  BuildReportInput,
  FailureRecord,
  RawFailure,
  SrcMapIndex,
  CcClientHandle,
} from "../types/report.js";
import { ReportError } from "../types/report.js";
import { redactHeaders, redactBody } from "./redact.js";
import { processStack } from "./sourceMap.js";
import { callCcForPatch } from "./ccSuggestFix.js";
import { applySizeCap } from "./sizeCap.js";
import { writeTestSpriteCompat, shouldEmitTestSpriteCompat } from "./testspriteCompat.js";

const DOM_BYTE_LIMIT = 30 * 1024;  // 30 KB
const BODY_BYTE_LIMIT = 10 * 1024; // 10 KB
const MAX_CC_PARALLEL = 5;

// B-4-25: normalize backslashes to forward-slashes before hashing
function normalizeTestFilePath(testFile: string): string {
  return testFile.replace(/\\/g, "/");
}

/**
 * B-4-4 + B-4-25: Stable testId — sha256(normalizedTestFile + "\x00" + testName).slice(0,12)
 */
function computeTestId(testFile: string, testName: string): string {
  const normalized = normalizeTestFilePath(testFile);
  return createHash("sha256")
    .update(normalized + "\x00" + testName)
    .digest("hex")
    .slice(0, 12);
}

/**
 * B-4-23: Classify failure kind from rawStack and failure input.
 */
function classifyFailureKind(
  raw: RawFailure,
): import("../types/report.js").FailureKind {
  const stack = raw.rawStack || "";

  if (/TimeoutError|exceeded timeout/i.test(stack)) return "TIMEOUT";
  if (/Error: expect\(|AssertionError/i.test(stack)) return "ASSERTION";

  // Network: backend network failure + page navigation
  if (
    raw.networkEntries?.some(
      (e) => e.status !== undefined && (e.status >= 400 || e.status === 0),
    ) ||
    /ECONNREFUSED/i.test(stack)
  ) {
    if (/page\.goto|fetch/i.test(stack) || raw.lastAction) return "NETWORK";
  }

  if (/Navigation.*failed|failed.*navigation/i.test(stack)) return "NAVIGATION";

  if (raw.screenshotPath && /visual|screenshot|diff/i.test(stack)) return "VISUAL";

  return "EXCEPTION";
}

/**
 * Truncate domHtml to ≤30 KB (UTF-8 bytes) at last element boundary.
 * B-4-8.
 */
function truncateDom(html: string): string {
  const enc = new TextEncoder();
  const bytes = enc.encode(html);
  if (bytes.length <= DOM_BYTE_LIMIT) return html;

  // Walk backwards from DOM_BYTE_LIMIT char position to find last '>'
  // Decode the first DOM_BYTE_LIMIT bytes to a string
  const sliced = new TextDecoder().decode(bytes.slice(0, DOM_BYTE_LIMIT));
  let i = sliced.length - 1;
  while (i > 0 && sliced[i] !== ">") i--;
  return sliced.slice(0, i + 1) + "\n<!-- [dom truncated] -->";
}

/**
 * Cap body string to 10 KB (UTF-8 bytes).
 */
function capBody(body: string | undefined): string | undefined {
  if (body === undefined) return undefined;
  const enc = new TextEncoder();
  const bytes = enc.encode(body);
  if (bytes.length <= BODY_BYTE_LIMIT) return body;
  return new TextDecoder().decode(bytes.slice(0, BODY_BYTE_LIMIT));
}

/**
 * Extract the first line of errorMessage from the rawStack (or use it directly).
 * Capped at 500 chars per B-4-10.
 */
function extractErrorMessage(rawStack: string): string {
  const firstLine = rawStack.split("\n")[0] ?? "";
  return firstLine.slice(0, 500);
}

// Semaphore-style parallel limiter
async function runWithConcurrencyLimit<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  const queue = [...tasks.entries()];

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      const [idx, task] = item;
      results[idx] = await task();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function buildFailureRecord(
  raw: RawFailure,
  projectPath: string,
  srcMaps: SrcMapIndex,
  cc: CcClientHandle,
): Promise<FailureRecord> {
  const testId = computeTestId(raw.testFile, raw.testName);
  const failureKind = classifyFailureKind(raw);

  // B-4-10: errorMessage ≤ 500 chars
  const errorMessage = extractErrorMessage(raw.rawStack);

  // B-4-9: stack cleaned + source-mapped + ≤8 KB
  const { stack, suggestedFixRegion } = processStack(raw.rawStack, srcMaps, projectPath);

  // Call cc for patch suggestion
  const ccResult = await callCcForPatch({
    cc,
    testFile: raw.testFile,
    testName: raw.testName,
    errorMessage,
    stack,
    fixRegion: suggestedFixRegion,
  });

  // Build the base record
  const record: FailureRecord = {
    testId,
    testName: raw.testName,
    testFile: raw.testFile,
    testType: raw.testType,
    failureKind,
    errorMessage,
    stack,
    relatedFiles: ccResult.relatedFiles,
    confidence: ccResult.confidence,
    costCcCalls: ccResult.costCcCalls,
    costMs: ccResult.costMs,
  };

  // suggestedFixRegion: B-4-11 / B-4-12
  if (suggestedFixRegion) {
    record.suggestedFixRegion = suggestedFixRegion;
  }

  // suggestedPatch: B-4-2 (only present when confidence >= 0.7)
  if (ccResult.patch !== undefined) {
    record.suggestedPatch = ccResult.patch;
  }

  // Frontend-only fields (B-4-17: absent for backend tests)
  if (raw.testType === "frontend-e2e") {
    if (raw.domHtml !== undefined) {
      record.domSnapshot = truncateDom(raw.domHtml);
    }
    if (raw.screenshotPath !== undefined) {
      record.screenshotPath = raw.screenshotPath;
    }
    if (raw.consoleEntries !== undefined && raw.consoleEntries.length > 0) {
      record.consoleErrors = raw.consoleEntries.map((e) => ({
        level: (["log", "warn", "error"].includes(e.level) ? e.level : "log") as
          | "log"
          | "warn"
          | "error",
        message: e.message.slice(0, 500),
        timestamp: e.timestamp,
      }));
    }
    if (raw.networkEntries !== undefined && raw.networkEntries.length > 0) {
      record.networkErrors = raw.networkEntries.map((e) => ({
        url: e.url,
        method: e.method,
        status: e.status,
        errorText: e.errorText,
      }));
    }
    if (raw.lastUrl !== undefined) {
      record.lastUrl = raw.lastUrl;
    }
    if (raw.lastAction !== undefined) {
      record.lastAction = raw.lastAction;
    }
  }

  // Backend-only fields (B-4-18: absent for frontend tests)
  if (raw.testType === "backend-integration") {
    if (raw.httpRequest !== undefined) {
      record.request = {
        method: raw.httpRequest.method,
        url: raw.httpRequest.url,
        headers: redactHeaders(raw.httpRequest.headers),
        body: redactBody(capBody(raw.httpRequest.body)),
      };
    }
    if (raw.httpResponse !== undefined) {
      record.response = {
        status: raw.httpResponse.status,
        headers: redactHeaders(raw.httpResponse.headers),
        body: redactBody(capBody(raw.httpResponse.body)),
      };
    }
    if (raw.dbRows !== undefined) {
      record.dbSnapshot = {
        tables: raw.dbRows,
        capturedAt: new Date().toISOString(),
      };
    }
  }

  return record;
}

export interface BuildReportOptions {
  emitTestSpriteCompat?: boolean;
}

export async function buildReport(
  input: BuildReportInput,
  options?: BuildReportOptions,
): Promise<AutoPatchReport> {
  const { runId, projectPath, testRunResult, srcMaps, cc } = input;
  const generatedAt = new Date().toISOString();

  // Build failure records in parallel (max 5 concurrent cc calls)
  const tasks = testRunResult.failures.map(
    (raw) => () => buildFailureRecord(raw, projectPath, srcMaps, cc),
  );
  const failures = await runWithConcurrencyLimit(tasks, MAX_CC_PARALLEL);

  const report: AutoPatchReport = {
    runId,
    projectPath,
    generatedAt,
    summary: {
      total: testRunResult.total,
      passed: testRunResult.passed,
      failed: testRunResult.failed,
      skipped: testRunResult.skipped,
      durationMs: testRunResult.durationMs,
    },
    failures,
  };

  // Apply 500 KB size cap
  const cappedReport = applySizeCap(report);

  // Validate serialization (B-4-26: REPORT_SERIALIZATION_FAILED on circular ref)
  try {
    JSON.stringify(cappedReport);
  } catch (err) {
    throw new ReportError("REPORT_SERIALIZATION_FAILED", err);
  }

  // TestSprite compat side effect
  if (shouldEmitTestSpriteCompat(undefined, options?.emitTestSpriteCompat)) {
    // Fire-and-forget; errors are non-fatal
    writeTestSpriteCompat(cappedReport, projectPath).catch(() => {
      // Swallow — compat write failure must not fail buildReport
    });
  }

  return cappedReport;
}
