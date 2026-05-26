/**
 * Public module types for the auto-patch report module.
 * Exported as part of the public surface.
 */

export type FailureKind =
  | "ASSERTION"
  | "TIMEOUT"
  | "EXCEPTION"
  | "NAVIGATION"
  | "NETWORK"
  | "VISUAL";

export interface ConsoleEntry {
  level: "log" | "warn" | "error";
  message: string;    // ≤500 chars
  timestamp: string;  // ISO 8601
}

export interface NetworkError {
  url: string;
  method: string;
  status?: number;
  errorText?: string;
}

export interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;  // secrets replaced with "[REDACTED]"
  body?: string;                    // ≤10 KB; null if no body
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;  // secrets replaced with "[REDACTED]"
  body?: string;                    // ≤10 KB
}

export interface DbSnapshot {
  tables: Record<string, unknown[]>;
  capturedAt: string;  // ISO 8601
}

export interface FixRegion {
  file: string;        // project-relative
  lineStart: number;   // 1-indexed
  lineEnd: number;     // 1-indexed; lineEnd >= lineStart always
  why: string;         // ≤300 chars
}

export interface RunSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
}

export interface FailureRecord {
  // Identity
  testId: string;                // 12-char hex, stable across re-runs for same test
  testName: string;
  testFile: string;              // project-relative
  testType: "frontend-e2e" | "backend-integration";

  // Classification
  failureKind: FailureKind;
  errorMessage: string;          // ≤500 chars
  stack: string;                 // cleaned, source-mapped; ≤8 KB

  // Frontend-only (all optional; undefined for backend tests)
  domSnapshot?: string;          // ≤30 KB
  screenshotPath?: string;       // absolute path to PNG on local filesystem
  consoleErrors?: ConsoleEntry[];
  networkErrors?: NetworkError[];
  lastUrl?: string;
  lastAction?: string;

  // Backend-only (all optional; undefined for frontend tests)
  request?: HttpRequest;
  response?: HttpResponse;
  dbSnapshot?: DbSnapshot;

  // Fix guidance
  suggestedFixRegion?: FixRegion;  // absent when stack is empty or unparseable
  suggestedPatch?: string;          // unified diff; absent when confidence < 0.7
  relatedFiles: string[];           // project-relative; [] when unknown
  confidence: number;               // [0, 1]; 0 when cc failed or timed out

  // Telemetry
  costCcCalls: number;
  costMs: number;
}

export interface AutoPatchReport {
  runId: string;
  projectPath: string;
  generatedAt: string;           // ISO 8601 UTC string
  summary: RunSummary;
  failures: FailureRecord[];     // length === summary.failed; [] when all pass
}

export interface RawFailure {
  testName: string;
  testFile: string;        // project-relative path
  testType: "frontend-e2e" | "backend-integration";
  rawStack: string;        // unprocessed stderr from runner
  // Frontend runner augments:
  domHtml?: string;
  screenshotPath?: string;
  consoleEntries?: Array<{ level: string; message: string; timestamp: string }>;
  networkEntries?: Array<{ url: string; method: string; status?: number; errorText?: string }>;
  lastUrl?: string;
  lastAction?: string;
  // Backend runner augments:
  httpRequest?: { method: string; url: string; headers: Record<string, string>; body?: string };
  httpResponse?: { status: number; headers: Record<string, string>; body?: string };
  dbRows?: Record<string, unknown[]>;
}

export interface TestRunResult {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  failures: RawFailure[];  // one entry per failed test; empty array when all pass
}

// Opaque types — callers treat as unknown; only builder uses internals
export type SrcMapIndex = Record<string, unknown>;
export type CcClientHandle = { invoke: (prompt: string, opts?: object) => Promise<string> };

export interface BuildReportInput {
  runId: string;           // UUID v4 — caller supplies; must be non-empty string
  projectPath: string;     // absolute path to user project being tested
  testRunResult: TestRunResult;
  srcMaps: SrcMapIndex;    // opaque index built by sandbox runner; pass {} if none
  cc: CcClientHandle;      // opaque handle to cc subprocess pool
}

export class ReportError extends Error {
  code: "REPORT_SERIALIZATION_FAILED";
  constructor(code: "REPORT_SERIALIZATION_FAILED", cause?: unknown) {
    super(`Report error: ${code}`);
    this.name = "ReportError";
    this.code = code;
    this.cause = cause;
  }
}
