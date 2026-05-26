# Module 04 — Auto-Patch Report: Public Surface

> SPEC-SPLIT artifact (blackbox-readable surface)
> Module: `src/report/`
> Companion spec: `docs/details/04-autopatch-report-spec.md`
> Status: draft, 2026-05-26
>
> **Reading rules for blackbox test authors**: this document is the ONLY input you need.
> Do NOT read the spec or any source file. Everything you need to write meaningful
> assertions is here.

---

## 1. Entry Point

```typescript
import { buildReport } from "tspr/report";

async function buildReport(input: BuildReportInput): Promise<AutoPatchReport>
```

### `BuildReportInput`

```typescript
interface BuildReportInput {
  runId: string;           // UUID v4 — caller supplies; must be non-empty string
  projectPath: string;     // absolute path to user project being tested
  testRunResult: TestRunResult;
  srcMaps: SrcMapIndex;    // opaque index built by sandbox runner; pass {} if none
  cc: CcClientHandle;      // opaque handle to cc subprocess pool
}

interface TestRunResult {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  failures: RawFailure[];  // one entry per failed test; empty array when all pass
}

interface RawFailure {
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
  httpRequest?: { method: string; url: string; headers: Record<string,string>; body?: string };
  httpResponse?: { status: number; headers: Record<string,string>; body?: string };
  dbRows?: Record<string, unknown[]>;
}

// Opaque types — callers treat as unknown; only builder uses internals
type SrcMapIndex = Record<string, unknown>;
type CcClientHandle = { invoke: (prompt: string, opts?: object) => Promise<string> };
```

---

## 2. Return Type — `AutoPatchReport`

```typescript
interface AutoPatchReport {
  runId: string;
  projectPath: string;
  generatedAt: string;           // ISO 8601 UTC string
  summary: RunSummary;
  failures: FailureRecord[];     // length === summary.failed; [] when all pass
}

interface RunSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
}

interface FailureRecord {
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

type FailureKind =
  | "ASSERTION"
  | "TIMEOUT"
  | "EXCEPTION"
  | "NAVIGATION"
  | "NETWORK"
  | "VISUAL";

interface ConsoleEntry {
  level: "log" | "warn" | "error";
  message: string;    // ≤500 chars
  timestamp: string;  // ISO 8601
}

interface NetworkError {
  url: string;
  method: string;
  status?: number;
  errorText?: string;
}

interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;  // secrets replaced with "[REDACTED]"
  body?: string;                    // ≤10 KB; null if no body
}

interface HttpResponse {
  status: number;
  headers: Record<string, string>;  // secrets replaced with "[REDACTED]"
  body?: string;                    // ≤10 KB
}

interface DbSnapshot {
  tables: Record<string, unknown[]>;
  capturedAt: string;  // ISO 8601
}

interface FixRegion {
  file: string;        // project-relative
  lineStart: number;   // 1-indexed
  lineEnd: number;     // 1-indexed; lineEnd >= lineStart always
  why: string;         // ≤300 chars
}
```

---

## 3. Behavior Contracts

Each contract is numbered B-4-N. A blackbox test author may write one or more test cases per contract.

### B-4-1: Report always returned

`buildReport` always resolves to an `AutoPatchReport` (never rejects) as long as `runId` and `projectPath` are non-empty strings. Errors in individual field population (source-map lookup, cc call, screenshot write) degrade gracefully: the affected field is absent, other fields are still populated.

### B-4-2: `suggestedPatch` omitted when confidence < 0.7

If the cc subprocess rates its confidence at less than 0.7 (i.e., raw integer score < 7 on a 0–10 scale), the `suggestedPatch` field MUST be absent from the `FailureRecord`. The `confidence` field IS present regardless and reflects the actual rating.

### B-4-3: `failures` length matches `summary.failed`

`report.failures.length === report.summary.failed` is always true. Passing tests do not appear in `failures`.

### B-4-4: `testId` is stable

Given the same `testFile` and `testName`, `testId` is identical across separate `buildReport` calls. It does not depend on `runId`, `projectPath`, or execution time.

### B-4-5: Authorization-class headers redacted

Any header whose **name** matches (case-insensitive) the pattern `/authorization|x-api-key|cookie|set-cookie/i` has its value replaced with `"[REDACTED]"` in both `request.headers` and `response.headers`. The header key is preserved; only the value is replaced.

### B-4-6: Secret-pattern headers redacted

Any header whose **name** matches (case-insensitive) `/api[_-]?key|secret|token|password/i` has its value replaced with `"[REDACTED]"`. Applies to both request and response headers.

### B-4-7: Secret-pattern body values redacted

In `request.body` and `response.body` (when they are strings containing JSON), any JSON value associated with a key matching `/password|secret|token|api[_-]?key/i` is replaced with `"[REDACTED]"`. The key name is preserved.

### B-4-8: `domSnapshot` ≤ 30 KB

`failure.domSnapshot`, when present, is at most 30 × 1024 bytes when encoded as UTF-8. If truncated, the string ends with `<!-- [dom truncated] -->`.

### B-4-9: `stack` ≤ 8 KB

`failure.stack`, when present, is at most 8 × 1024 bytes when encoded as UTF-8. If truncated, the string ends with `[truncated]`.

### B-4-10: `errorMessage` ≤ 500 chars

`failure.errorMessage.length <= 500` always.

### B-4-11: `suggestedFixRegion` absent when stack unparseable

If `rawStack` is an empty string or contains only frames from `node_modules` / runner internals (no user-space frames are found), `suggestedFixRegion` MUST be absent.

### B-4-12: `suggestedFixRegion.lineEnd >= suggestedFixRegion.lineStart`

When `suggestedFixRegion` is present, `lineEnd >= lineStart` is always true, and both are >= 1.

### B-4-13: `confidence` in [0, 1]

`failure.confidence` is always a number in the closed interval [0, 1]. It is never negative, never > 1, never NaN.

### B-4-14: `confidence = 0` when cc call fails or times out

If the cc subprocess throws, times out, or returns output that cannot be parsed for a CONFIDENCE rating, `confidence` is set to `0` and `suggestedPatch` is absent (satisfying B-4-2 as a special case).

### B-4-15: `relatedFiles` is always an array

`failure.relatedFiles` is always an array (possibly empty `[]`). It is never `null` or `undefined`.

### B-4-16: Total report ≤ 500 KB (soft cap)

`JSON.stringify(report)` encoded as UTF-8 is at most 500 × 1024 bytes after the size-cap pass. Fields are dropped in the following order (earliest = first to drop) until the budget is satisfied:
  1. `domSnapshot` (all failures)
  2. `networkErrors` (all failures)
  3. `dbSnapshot` (all failures)
  4. `consoleErrors` (all failures)
  5. `request.body` (all failures)
  6. `response.body` (all failures)
  7. `suggestedPatch` (all failures)
  8. `stack` truncated to 2048 JavaScript characters (`string.length`; not UTF-8 bytes — distinct from B-4-9's byte cap which applies during normal stack cleaning) (all failures)

If the report still exceeds 500 KB after all drops, it is returned as-is (fields already dropped; no further truncation). A blackbox tester MUST NOT assert that the report is always strictly under 500 KB — the contract is best-effort.

### B-4-17: Frontend-only fields absent for backend tests

For any `FailureRecord` where `testType === "backend-integration"`, the fields `domSnapshot`, `screenshotPath`, `consoleErrors`, `networkErrors`, `lastUrl`, and `lastAction` MUST all be `undefined` (absent from JSON).

### B-4-18: Backend-only fields absent for frontend tests

For any `FailureRecord` where `testType === "frontend-e2e"`, the fields `request`, `response`, and `dbSnapshot` MUST all be `undefined` (absent from JSON).

### B-4-19: `generatedAt` is a valid ISO 8601 UTC string

`new Date(report.generatedAt)` must not return `Invalid Date`. The string must end with `Z`.

### B-4-20: `runId` echoed verbatim

`report.runId === input.runId`. No transformation is applied.

### B-4-21: `projectPath` echoed verbatim

`report.projectPath === input.projectPath`. No transformation is applied.

### B-4-22: Body redaction is recursive (all nesting depths)

When `request.body` or `response.body` is a JSON string, the redaction pattern `/("password"|"secret"|"token"|"api[_-]?key")\s*:\s*"[^"]+"/gi` is applied to the raw body string. Because the pattern matches on the body text directly (not via JSON parsing), it applies at **any nesting depth**. A deeply nested key such as `{"auth":{"password":"s3cr3t"}}` will have its value replaced with `"[REDACTED]"` just as a top-level key would. Top-level-only matching is explicitly excluded by this contract.

Example:
- Input: `'{"wrapper":{"password":"x"}}'`
- Output: `'{"wrapper":{"password":"[REDACTED]"}}'`

### B-4-23: `failureKind` canonical input examples

The internal classification priority order is an implementation detail (see §7). However, the following input → `failureKind` examples are guaranteed for well-formed inputs, and may be used in blackbox assertions:

| Observable signal in `rawStack` / failure input | Expected `failureKind` |
|---|---|
| Contains `TimeoutError` or the phrase `exceeded timeout` | `"TIMEOUT"` |
| Contains `Error: expect(` or `AssertionError` (and no timeout signal above) | `"ASSERTION"` |
| No other signal matches; `rawStack` is non-empty and has user-space frames | `"EXCEPTION"` (fallback) |

These three examples are a non-exhaustive subset. The full priority ordering (including `NETWORK`, `NAVIGATION`, `VISUAL`) is implementation-defined and must not be relied upon for edge cases not listed above.

### B-4-24: `confidence` normalization formula

The `confidence` field in `FailureRecord` is computed from the cc subprocess's raw integer score by the formula:

```
confidence = rawScore / 10
```

where `rawScore` is the integer N parsed from the `CONFIDENCE:N` line in the cc response. `rawScore` is expected to be an integer in the range [0, 10].

Non-integer raw scores (e.g., `6.5`) are accepted and normalized by the same formula, yielding `confidence = 0.65`.

Corollary (for threshold testing):
- `rawScore = 6` → `confidence = 0.6` → `suggestedPatch` absent (B-4-2)
- `rawScore = 7` → `confidence = 0.7` → `suggestedPatch` present (B-4-2)

### B-4-25: `testId` is computed from path-normalized inputs

`testId` is derived by `sha256(normalizedTestFile + "\x00" + testName).slice(0, 12)` where `normalizedTestFile` is `testFile` with all backslash (`\`) path separators replaced with forward-slash (`/`) before hashing.

This normalization ensures `testId` is identical across platforms (Windows and POSIX) for the same logical test, regardless of which path separator the test runner uses.

A blackbox tester may assert that providing `"src\\tests\\login.ts"` and `"src/tests/login.ts"` as `testFile` for otherwise identical inputs produces the **same** `testId`.

### B-4-26: `REPORT_SERIALIZATION_FAILED` cannot be triggered by external input

`REPORT_SERIALIZATION_FAILED` is a programmer-error sentinel thrown only when `JSON.stringify(report)` encounters a circular reference introduced by a bug in the report builder itself. It is **not possible** for a well-formed `BuildReportInput` (as defined in §1) to trigger this error.

A blackbox test author MUST NOT expect to be able to inject a triggering condition through the public API. This error code is verified by internal unit tests that have access to the implementation. External (blackbox) tests should document it as "observable only in form: if thrown, it is a `ReportError` with `code === "REPORT_SERIALIZATION_FAILED"`" — but cannot write a reproducible trigger scenario from the outside.

---

## 4. Error Codes

These are thrown (as `ReportError` instances) only in non-recoverable situations. Field-level failures degrade gracefully (see B-4-1).

| Code | When thrown |
|---|---|
| `REPORT_SERIALIZATION_FAILED` | `JSON.stringify(report)` throws (e.g. circular reference introduced by a bug). This is a programmer error and should never occur in normal operation. |
| `SOURCE_MAP_NOT_FOUND` | Not thrown. Source-map absence is a graceful degradation: raw frames are used. |
| `CC_TIMEOUT` | Not thrown. cc timeout is a graceful degradation: `confidence = 0`, `suggestedPatch` absent (B-4-14). |

`ReportError` shape:

```typescript
class ReportError extends Error {
  code: "REPORT_SERIALIZATION_FAILED";  // only current member
  cause?: unknown;
}
```

---

## 5. Field Semantics Table

| Field | Meaning |
|---|---|
| `runId` | Unique identifier for this generate-and-execute invocation. Stable reference for dashboard lookup and `rerun_tests` correlation. |
| `projectPath` | Absolute filesystem path to the user's project root. Useful for resolving `testFile` and `relatedFiles` to absolute paths. |
| `generatedAt` | When the report was assembled (not when the test run started). |
| `summary.total` | Count of test cases attempted (passed + failed + skipped). |
| `summary.durationMs` | Wall-clock time for the entire test run inside the sandbox, not including report-assembly time. |
| `failures[].testId` | Stable 12-char hex ID for the specific test case. Repeat runs of the same test produce the same `testId`. Used to track flakiness in dashboard. |
| `failures[].failureKind` | Coarse classification of why the test failed. Useful for routing fix strategies: `ASSERTION` → logic bug; `TIMEOUT` → performance or missing await; `NETWORK` → API contract mismatch; `VISUAL` → CSS regression. |
| `failures[].errorMessage` | First meaningful line of the failure message. Short enough to show in a list view without truncation. |
| `failures[].stack` | Source-mapped stack trace. Frames from `node_modules` and runner internals are removed. Use this to find the test line and the application line that triggered the failure. |
| `failures[].domSnapshot` | HTML of the page at the moment of failure. Useful for understanding what the user would have seen. Truncated at element boundary. |
| `failures[].screenshotPath` | Absolute path to a PNG file capturing the browser viewport at failure. The file persists on disk until user clears `~/.tspr/screenshots/`. |
| `failures[].consoleErrors` | Browser console entries emitted before the failure. Often reveals API errors or unhandled promise rejections. |
| `failures[].networkErrors` | Failed HTTP requests detected by browser network interception. Use with `failureKind === "NETWORK"`. |
| `failures[].lastUrl` | Browser URL at failure. Useful for distinguishing "navigated to wrong page" from "correct page but wrong content". |
| `failures[].lastAction` | Last Playwright interaction string before failure. Useful for reproducing the failure manually. |
| `failures[].request` | The HTTP request that the integration test made when it failed. Headers are redacted. |
| `failures[].response` | The HTTP response received. Use `response.status` to confirm the test's assertion (e.g. expected 200 got 401). |
| `failures[].dbSnapshot` | Database rows captured at failure. Useful for verifying that the failure is a data issue vs a code issue. |
| `failures[].suggestedFixRegion` | File + line range that cc identified as the most likely fix location. `why` explains the reasoning. Use as the starting point for manual inspection. |
| `failures[].suggestedPatch` | Unified diff proposed by cc. Only present when cc has confidence >= 0.7. Apply with `git apply` or review in a diff viewer. |
| `failures[].relatedFiles` | Other files cc flagged as likely needing changes alongside the primary fix region. |
| `failures[].confidence` | cc's self-assessed probability (0–1) that `suggestedPatch` fixes the test. 0 = cc could not generate a patch. |
| `failures[].costCcCalls` | Number of cc subprocess invocations made while analysing this specific failure. Telemetry only. |
| `failures[].costMs` | Wall-clock milliseconds spent in cc calls for this failure. Telemetry only. |

---

## 6. MCP Tool Return Shape

The `AutoPatchReport` is returned by `tspr_generate_code_and_execute` as:

```typescript
{
  content: [
    {
      type: "text",
      text: "<JSON.stringify(AutoPatchReport)>"
    }
  ]
}
```

The calling agent must `JSON.parse(result.content[0].text)` to get the structured object. The MCP `text` field is a plain JSON string; it is never base64-encoded.

---

## 7. What Is NOT in This Surface

The following are implementation details. Blackbox test authors must not rely on them:

- Which source-map library is used internally
- The exact cc prompt template
- Internal TypeScript types in `src/report/types.ts`
- SQLite table schema
- Docker container lifecycle
- Whether `buildReport` uses async parallelism internally
- The exact text of `why` in `suggestedFixRegion` (beyond it being ≤300 chars)
- How `FailureKind` classification priority is ordered internally
