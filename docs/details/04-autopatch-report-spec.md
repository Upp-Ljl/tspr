# Module 04 — Auto-Patch Report: Dev Spec

> SPEC-SPLIT artifact (dev side)
> Module: `src/report/`
> Related surface: `docs/details/04-autopatch-report-public-surface.md`
> Status: draft, 2026-05-26

---

## 0. Purpose

When `localsprite_generate_code_and_execute` runs tests and any of them fail, the tool does **not** apply patches. Instead it builds a structured `AutoPatchReport` JSON and returns it as the MCP tool response body. The calling coding agent (Claude Code / Cursor) reads that JSON, decides whether/how to fix the code, and may call `localsprite_rerun_tests` when done.

This spec covers:
- The exact JSON shape (top-level + per-failure)
- How every field is populated
- Redaction rules
- Size-cap behaviour
- MCP wire encoding
- TestSprite backwards-compat shim

---

## 1. File Layout

```
src/report/
├── index.ts            # re-exports buildReport
├── builder.ts          # main buildReport() orchestrator
├── failure.ts          # per-failure object construction
├── sourceMap.ts        # stack → source-mapped frames → suggestedFixRegion
├── ccPatch.ts          # cc subprocess call → suggestedPatch + confidence
├── redact.ts           # header / body secret scrubbing
├── sizeCap.ts          # 500 KB budget enforcement
├── testspriteCompat.ts # emit test_results.json in TestSprite key shape
└── types.ts            # internal TypeScript types (not exported as public surface)
```

---

## 2. Top-Level Report Shape

```typescript
interface AutoPatchReport {
  runId: string;               // UUID v4, generated per generate_code_and_execute call
  projectPath: string;         // absolute path passed to the tool
  generatedAt: string;         // ISO 8601 UTC, e.g. "2026-05-26T14:32:00.000Z"
  summary: RunSummary;
  failures: FailureRecord[];   // only failed tests; length === summary.failed
}

interface RunSummary {
  total: number;               // tests attempted
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;          // wall-clock ms for entire test run
}
```

`failures` is an empty array when all tests pass. In that case the MCP tool still returns this structure (with `summary.failed === 0`) so callers have a single parsing path.

---

## 3. Per-Failure Object Shape

```typescript
interface FailureRecord {
  // --- Identity ---
  testId: string;              // stable ID: sha256(testFile + testName).slice(0,12)
  testName: string;            // human-readable name from runner output
  testFile: string;            // project-relative path, e.g. "tests/checkout.spec.ts"
  testType: "frontend-e2e" | "backend-integration";

  // --- Failure Classification ---
  failureKind: FailureKind;
  errorMessage: string;        // first line of runner error, ≤500 chars
  stack: string;               // cleaned, source-mapped stack, ≤8 KB

  // --- Frontend-only (undefined for backend) ---
  domSnapshot?: string;        // page.content() at point of failure, ≤30 KB
  screenshotPath?: string;     // absolute path to PNG written to .localsprite/screenshots/
  consoleErrors?: ConsoleEntry[];
  networkErrors?: NetworkError[];
  lastUrl?: string;            // page.url() at point of failure
  lastAction?: string;         // last Playwright action string, e.g. "click('#submit')"

  // --- Backend-only (undefined for frontend) ---
  request?: HttpRequest;
  response?: HttpResponse;
  dbSnapshot?: DbSnapshot;     // optional; only included if db introspection enabled

  // --- Fix Guidance ---
  suggestedFixRegion?: FixRegion;  // derived from stack; absent if stack empty
  suggestedPatch?: string;         // unified diff; present only when confidence >= 0.7
  relatedFiles: string[];          // project-relative paths cc flags as likely co-changes
  confidence: number;              // [0,1]; cc self-rating / 10

  // --- Telemetry ---
  costCcCalls: number;         // count of cc subprocess invocations for this failure
  costMs: number;              // wall-clock ms spent in cc calls for this failure
}
```

### 3.1 FailureKind Enum

```typescript
type FailureKind =
  | "ASSERTION"    // expect/assert mismatch
  | "TIMEOUT"      // Playwright waitFor / test timeout
  | "EXCEPTION"    // unhandled exception / crash
  | "NAVIGATION"   // page failed to navigate (404, redirect loop)
  | "NETWORK"      // fetch/XHR returned error status or connection refused
  | "VISUAL";      // screenshot diff exceeds threshold
```

Classification logic (in `failure.ts`):
1. If runner output contains `TimeoutError` or `exceeded timeout` → `TIMEOUT`
2. Else if runner output contains `Error: expect(` or `AssertionError` → `ASSERTION`
3. Else if network interception captured a failed request (4xx/5xx or ECONNREFUSED) and the test body used `page.goto` or `fetch` → `NETWORK`
4. Else if runner output contains `Navigation` + failed → `NAVIGATION`
5. Else if screenshot diff path present and diff > threshold → `VISUAL`
6. Fallback → `EXCEPTION`

### 3.2 Nested Types

```typescript
interface ConsoleEntry {
  level: "log" | "warn" | "error";
  message: string;    // ≤500 chars
  timestamp: string;  // ISO 8601
}

interface NetworkError {
  url: string;
  method: string;
  status?: number;    // absent for connection-refused
  errorText?: string; // Playwright net error string
}

interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;  // redacted per §6
  body?: string;                    // ≤10 KB; redacted per §6
}

interface HttpResponse {
  status: number;
  headers: Record<string, string>;  // redacted per §6
  body?: string;                    // ≤10 KB
}

interface DbSnapshot {
  tables: Record<string, unknown[]>; // { tableName: rows[] }
  capturedAt: string;               // ISO 8601
}

interface FixRegion {
  file: string;       // project-relative path
  lineStart: number;  // 1-indexed
  lineEnd: number;    // 1-indexed; lineEnd >= lineStart
  why: string;        // ≤300 chars; reason this region was selected
}
```

---

## 4. Field Population Details

### 4.1 `testId`

```typescript
import { createHash } from "crypto";
const testId = createHash("sha256")
  .update(testFile + "\x00" + testName)
  .digest("hex")
  .slice(0, 12);
```

Stable across re-runs for the same test; used as join key in SQLite `test_results` table.

### 4.2 `stack` — Cleaning + Source-Mapping

`src/report/sourceMap.ts` pipeline:

1. **Raw capture**: capture runner stderr as string.
2. **Strip runner internals**: remove lines matching:
   - `node_modules/` frames
   - `internal/` Node core frames
   - Playwright internal frames (`playwright-core/`)
3. **Source-map resolution**: for each remaining frame, if the file ends in `.js` and a `.map` file exists (or the file contains `//# sourceMappingURL`):
   - Use `@jridgewell/trace-mapping` to resolve original TS file + line
   - Replace the compiled frame with the TS frame
4. **Truncate**: if result > 8 KB, truncate at the last complete line under the limit, append `[truncated]`.

`suggestedFixRegion` is derived from the **first user-space frame** (after stripping, before truncation):

```typescript
const firstUserFrame = cleanedFrames[0];
suggestedFixRegion = {
  file: firstUserFrame.file,          // project-relative
  lineStart: Math.max(1, firstUserFrame.line - 5),
  lineEnd: firstUserFrame.line + 15,
  why: `First user-space stack frame at line ${firstUserFrame.line}`,
};
```

`lineStart` is padded 5 lines up (context), `lineEnd` is 15 lines down. This gives cc a ~20-line window to understand the failure site.

### 4.3 `domSnapshot`

Captured via Playwright's `page.content()` immediately after the failing action. Truncation at element boundary:

```typescript
function truncateDom(html: string, maxBytes = 30 * 1024): string {
  const enc = new TextEncoder();
  if (enc.encode(html).length <= maxBytes) return html;
  // walk backwards from char at maxBytes, find last '>' before that point
  let i = maxBytes;
  while (i > 0 && html[i] !== ">") i--;
  return html.slice(0, i + 1) + "\n<!-- [dom truncated] -->";
}
```

### 4.4 `screenshotPath`

Playwright `page.screenshot()` is called in the `afterEach`-equivalent hook:

```typescript
const dir = path.join(os.homedir(), ".localsprite", "screenshots");
await fs.mkdir(dir, { recursive: true });
const filename = `${runId}-${testId}-${Date.now()}.png`;
const screenshotPath = path.join(dir, filename);
await page.screenshot({ path: screenshotPath, fullPage: true });
```

Absolute path is stored in the report. The path persists until user clears `~/.localsprite/screenshots/`.

### 4.5 `suggestedPatch` + `confidence`

`src/report/ccPatch.ts` orchestrates a cc subprocess call for each failed test:

**Prompt template** (sent via `claude --model sonnet -p`):

```
You are a code-repair assistant. A test failed. Analyse the failure and propose a minimal fix.

## Failing test
File: <testFile>
Name: <testName>
Error: <errorMessage>
Stack:
<stack>

## Code region (likely fix site)
File: <fixRegion.file>, lines <lineStart>–<lineEnd>:
<file contents of that region>

## Task
1. Propose a unified diff (--- a/... +++ b/... format) that fixes this test.
2. On the last line, output EXACTLY: CONFIDENCE:<n> where n is 0-10 (integer).

Output only the diff block and the CONFIDENCE line. No prose.
```

Parse response:
- Extract `CONFIDENCE:N` from last line, compute `confidence = N / 10`.
- Everything before that line is `suggestedPatch`.
- If confidence < 0.7 (i.e., N < 7): include the patch but mark the field as present (callers filter by confidence).
- Actually per contract B-4-2: **omit** `suggestedPatch` from the JSON when confidence < 0.7.

`relatedFiles`: prompt asks cc to list any other files it thinks might need touching; parsed from a structured section in the response when confidence >= 0.5, else `[]`.

`costCcCalls` is incremented once per cc subprocess call. If cc fails or times out, `suggestedPatch` is absent, `confidence` is `0`, and the error is logged but does not fail the report build (the report still returns).

### 4.6 `request` / `response` (Backend)

Captured by a vitest/supertest integration harness that wraps the HTTP layer. The harness intercepts the last request made before the assertion failure and serialises it. Headers are redacted per §6 before serialisation.

`body` is capped at 10 KB. If body is binary (Content-Type not text/* or application/json), store `[binary body omitted]`.

### 4.7 `dbSnapshot` (Backend, Optional)

Only captured when the test plan's scenario has `captureDb: true`. Implementation: after test failure, connect to the test database (connection string from environment captured during Docker run) and `SELECT * FROM <table>` for each table listed in the scenario. Result rows are stored as-is.

Cap: if snapshot JSON exceeds 50 KB, it is omitted entirely from the report (treated as if `captureDb` was false), and a warning is logged.

---

## 5. `buildReport()` Orchestrator Flow

```
buildReport({runId, projectPath, testRunResult, srcMaps, cc})
│
├─ for each failed test in testRunResult.failures (parallel, max 5):
│   ├─ build identity fields
│   ├─ classify failureKind
│   ├─ clean + source-map stack  →  suggestedFixRegion
│   ├─ (frontend) collect domSnapshot, screenshotPath, consoleErrors, networkErrors
│   ├─ (backend) collect request, response, dbSnapshot
│   ├─ call ccPatch()            →  suggestedPatch?, confidence, relatedFiles
│   └─ return FailureRecord
│
├─ assemble AutoPatchReport
├─ run sizeCap()                 →  drop fields if > 500 KB
├─ (if compat enabled) write testspriteCompat file
└─ return AutoPatchReport
```

Max parallelism for ccPatch calls is 5 (configurable). Above 5, failures queue. This prevents cc subprocess pile-up.

---

## 6. Redaction Rules

Implemented in `src/report/redact.ts`.

**Triggers**: any header name or value, or body substring, matching (case-insensitive):

```
/api[_-]?key|secret|token|password|authorization|x-api-key|cookie|set-cookie/i
```

**Header redaction**: if the header name matches the pattern, replace value with `[REDACTED]`.

**Body redaction**: scan body string for patterns:

```
/"(password|secret|token|api[_-]?key)"\s*:\s*"[^"]+"/gi
```

Replace matched value portion with `[REDACTED]`.

**Cookies**: `Cookie` and `Set-Cookie` headers are always redacted regardless of value content.

Redaction is applied before any field is written into `FailureRecord`. Redaction is not reversible.

---

## 7. Size Cap (500 KB Total)

Implemented in `src/report/sizeCap.ts`.

```typescript
function applySizeCap(report: AutoPatchReport): AutoPatchReport {
  const MAX = 500 * 1024; // bytes
  let json = JSON.stringify(report);
  if (Buffer.byteLength(json, "utf8") <= MAX) return report;

  // Drop in priority order (least diagnostic value first):
  const drops: Array<(r: AutoPatchReport) => void> = [
    (r) => r.failures.forEach((f) => { delete f.domSnapshot; }),
    (r) => r.failures.forEach((f) => { delete f.networkErrors; }),
    (r) => r.failures.forEach((f) => { delete f.dbSnapshot; }),
    (r) => r.failures.forEach((f) => { delete f.consoleErrors; }),
    (r) => r.failures.forEach((f) => { delete f.request?.body; }),
    (r) => r.failures.forEach((f) => { delete f.response?.body; }),
    (r) => r.failures.forEach((f) => { delete f.suggestedPatch; }),
    (r) => r.failures.forEach((f) => {
      if (f.stack && f.stack.length > 2048) f.stack = f.stack.slice(0, 2048) + "[truncated]";
    }),
  ];

  for (const drop of drops) {
    drop(report);
    json = JSON.stringify(report);
    if (Buffer.byteLength(json, "utf8") <= MAX) break;
  }
  return report;
}
```

If the report still exceeds 500 KB after all drops, it is returned as-is with a warning logged (the caller receives whatever is available; MCP transport may truncate further). This is a last-resort escape hatch only.

---

## 8. MCP Wire Encoding

The MCP tool `localsprite_generate_code_and_execute` returns:

```typescript
return {
  content: [
    {
      type: "text",
      text: JSON.stringify(report),   // AutoPatchReport
    },
  ],
};
```

The coding agent (cc / Cursor) receives this as the tool result and is expected to `JSON.parse` the `text` field to get the structured report. No binary framing, no gzip.

---

## 9. TestSprite Backwards-Compat Shim

When the environment variable `LOCALSPRITE_EMIT_TESTSPRITE_COMPAT=1` is set (or config option `emitTestSpriteCompat: true`), `src/report/testspriteCompat.ts` writes a separate file:

```
{projectPath}/.localsprite/test_results.json
```

This file uses TestSprite's published key names so that clients expecting the TestSprite format can consume it without change.

**Schema mapping table**:

| localsprite field | TestSprite equivalent | Notes |
|---|---|---|
| `runId` | `run_id` | same value |
| `summary.total` | `total_tests` | — |
| `summary.passed` | `passed` | — |
| `summary.failed` | `failed` | — |
| `summary.skipped` | `skipped` | — |
| `summary.durationMs` | `duration_ms` | — |
| `failures[].testId` | `failures[].failing_test_id` | — |
| `failures[].testName` | `failures[].test_name` | — |
| `failures[].testFile` | `failures[].test_file` | — |
| `failures[].errorMessage` | `failures[].error_message` | — |
| `failures[].stack` | `failures[].stack_trace` | — |
| `failures[].domSnapshot` | `failures[].dom_snapshot` | frontend only |
| `failures[].suggestedFixRegion` | `failures[].suggested_fix_region` (object with `file`, `line_start`, `line_end`, `why`) | note: snake_case |
| `failures[].suggestedPatch` | `failures[].suggested_patch` | only if present |
| `failures[].confidence` | not in TestSprite format | omitted |
| `failures[].relatedFiles` | `failures[].related_files` | — |

Fields with no TestSprite equivalent (`costCcCalls`, `costMs`, `confidence`) are omitted from the compat file.

The compat file is an additional side effect, not the primary MCP return value.

---

## 10. Error Handling

| Situation | Behaviour |
|---|---|
| Source map file not found | `suggestedFixRegion` derived from raw (not source-mapped) frame; no error thrown |
| cc subprocess times out (default 60 s) | `suggestedPatch` absent; `confidence = 0`; `costCcCalls` still incremented; report proceeds |
| JSON serialisation fails (circular ref etc.) | Throw `ReportError("REPORT_SERIALIZATION_FAILED", cause)` — propagated to MCP tool handler which returns an MCP error response |
| Screenshot write fails | `screenshotPath` absent; warning logged; non-fatal |
| dbSnapshot query fails | `dbSnapshot` absent; warning logged; non-fatal |

---

## 11. SQLite Persistence

After `buildReport` returns, `src/state/db.ts` persists the run:

```sql
INSERT INTO runs (run_id, project_path, generated_at, total, passed, failed, skipped, duration_ms, report_json)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);

INSERT INTO test_results (run_id, test_id, test_name, test_file, test_type, failure_kind, confidence, cost_cc_calls, cost_ms)
VALUES ...
-- one row per failure
```

`report_json` stores the full JSON for dashboard replay. `test_results` table is the join key for `rerun_tests`.

---

## Appendix A — Sample Report JSON (anonymised)

```json
{
  "runId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "projectPath": "/home/user/projects/shop-app",
  "generatedAt": "2026-05-26T14:32:00.000Z",
  "summary": {
    "total": 12,
    "passed": 10,
    "failed": 2,
    "skipped": 0,
    "durationMs": 34210
  },
  "failures": [
    {
      "testId": "c7f2a891b3d4",
      "testName": "checkout: places order when cart has items",
      "testFile": "tests/checkout.spec.ts",
      "testType": "frontend-e2e",
      "failureKind": "ASSERTION",
      "errorMessage": "expect(received).toBe(expected) — Expected: \"Order placed\", Received: \"\"",
      "stack": "Error: expect(received).toBe(expected)\n    at checkout.spec.ts:42:34\n    at async Page.<anonymous> (tests/checkout.spec.ts:38:5)",
      "domSnapshot": "<!DOCTYPE html><html><head><title>Shop</title></head><body><div id=\"cart\"><button id=\"checkout\">Checkout</button></div></body></html>",
      "screenshotPath": "/home/user/.localsprite/screenshots/a1b2c3d4-c7f2a891b3d4-1716733920000.png",
      "consoleErrors": [
        {
          "level": "error",
          "message": "POST /api/orders 500 (Internal Server Error)",
          "timestamp": "2026-05-26T14:31:58.123Z"
        }
      ],
      "networkErrors": [
        {
          "url": "http://localhost:3000/api/orders",
          "method": "POST",
          "status": 500,
          "errorText": "net::ERR_FAILED"
        }
      ],
      "lastUrl": "http://localhost:5173/checkout",
      "lastAction": "click('#checkout-submit')",
      "suggestedFixRegion": {
        "file": "src/api/orders.ts",
        "lineStart": 37,
        "lineEnd": 57,
        "why": "First user-space stack frame at line 42"
      },
      "suggestedPatch": "--- a/src/api/orders.ts\n+++ b/src/api/orders.ts\n@@ -40,7 +40,7 @@\n   try {\n-    const result = await db.insert(order);\n+    const result = await db.orders.insert(order);\n     res.json({ message: 'Order placed' });\n   } catch (err) {\n",
      "relatedFiles": ["src/db/schema.ts", "src/api/middleware/auth.ts"],
      "confidence": 0.8,
      "costCcCalls": 1,
      "costMs": 3840
    },
    {
      "testId": "9e1f3b720c56",
      "testName": "GET /api/products returns paginated list",
      "testFile": "tests/api/products.test.ts",
      "testType": "backend-integration",
      "failureKind": "ASSERTION",
      "errorMessage": "expected 200 but got 401",
      "stack": "AssertionError: expected 200 to equal 401\n    at products.test.ts:28:20",
      "request": {
        "method": "GET",
        "url": "http://localhost:3000/api/products?page=1&limit=10",
        "headers": {
          "Accept": "application/json",
          "Authorization": "[REDACTED]"
        },
        "body": null
      },
      "response": {
        "status": 401,
        "headers": {
          "Content-Type": "application/json",
          "Set-Cookie": "[REDACTED]"
        },
        "body": "{\"error\":\"Unauthorized\"}"
      },
      "suggestedFixRegion": {
        "file": "src/middleware/requireAuth.ts",
        "lineStart": 8,
        "lineEnd": 28,
        "why": "First user-space stack frame at line 13"
      },
      "relatedFiles": ["src/routes/products.ts"],
      "confidence": 0.6,
      "costCcCalls": 1,
      "costMs": 2910
    }
  ]
}
```

Note: `suggestedPatch` is absent for the second failure because `confidence = 0.6 < 0.7`.

---

## Appendix B — cc Prompt Template (full)

```
You are a code-repair assistant. A test failed. Analyse the failure and propose a minimal fix.

## Failing test
File: {{testFile}}
Name: {{testName}}
Error: {{errorMessage}}
Stack:
{{stack}}

## Code region (likely fix site)
File: {{fixRegion.file}}, lines {{fixRegion.lineStart}}–{{fixRegion.lineEnd}}:
{{regionContents}}

## Task
1. Propose a unified diff (--- a/... +++ b/... format) that fixes this test.
2. List any other files you think need changing: RELATED_FILES:<comma-separated project-relative paths>
3. On the last line, output EXACTLY: CONFIDENCE:<n> where n is 0-10 (integer, your certainty this patch fixes the test).

Output only the diff block, the RELATED_FILES line, and the CONFIDENCE line. No prose.
```
