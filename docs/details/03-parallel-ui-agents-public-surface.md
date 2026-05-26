# Module 03 — Parallel UI Exploration Agents: Public Surface

> SPEC-SPLIT artifact — public surface (blackbox-readable, implementation-free)
> Module: `src/ui-explore/`
> MCP tool: `localsprite_generate_frontend_test_plan` (tool 4, frontend path)
> Date: 2026-05-26
> Status: draft

This document is the sole input for the independent test-doc author.
It contains ONLY: function signatures, option schemas, output shapes, behavior contracts,
error codes, and determinism caveats.
It does NOT contain: Playwright API specifics, claude CLI flags, internal data structures,
frontier implementation, dedup algorithms, or file layout details.

---

## 1. Entry Point

```typescript
import { exploreUI } from 'localsprite/ui-explore';

const report: ExplorationReport = await exploreUI({
  baseUrl: string,       // REQUIRED. Absolute URL of running app, e.g. "http://localhost:3000"
  projectPath: string,   // REQUIRED. Absolute path to user's project root
  options?: ExploreUIOptions
});
```

`exploreUI` returns a resolved `Promise<ExplorationReport>` when exploration ends (for any stop reason) and the synthesis pass completes.

`exploreUI` rejects the Promise only for pre-flight errors (see Error Codes, section 5). All in-run errors are surfaced as fields within `ExplorationReport`, not as rejections.

---

## 2. Options Table

| Option | Type | Default | Description |
|---|---|---|---|
| `agentCount` | `number` (1–8) | `3` | Number of parallel exploration agents. Values outside 1–8 are clamped. |
| `timeBudgetMs` | `number` | `300_000` (5 min) | Wall-clock budget in milliseconds. Exploration stops when elapsed time exceeds this. |
| `maxPages` | `number` | `30` | Maximum distinct pages (by URL+structure) to visit. Stops when reached. |
| `maxCcCalls` | `number` | `50` | Maximum AI (cc subprocess) calls across all agents. Stops when reached. |
| `needLogin` | `boolean` | `false` | If true, run login sequence before starting agents. |
| `loginFixturePath` | `string \| undefined` | `undefined` | Absolute path to login fixture script. If `needLogin=true` and this is unset, auto-detection is attempted. |
| `costCapUsd` | `number \| undefined` | `undefined` | Optional hard cost cap in USD. Converted to a `maxCcCalls` estimate; the more restrictive of the two caps is used. |
| `urlQueryParamBlacklist` | `string[] \| undefined` | `undefined` | Additional URL query parameter names to strip during canonicalization (merged with built-in list). |

---

## 3. ExplorationReport Shape

```typescript
interface ExplorationReport {
  runId: string;                    // Unique run identifier, e.g. "run-<uuid>"
  generatedAt: string;              // UTC ISO 8601 timestamp, always ends with 'Z' (e.g. "2026-05-26T12:00:00.000Z")
  baseUrl: string;                  // Echo of input baseUrl
  stopReason: StopReason;           // Why exploration ended
  agentCount: number;               // Echo of options.agentCount (post-clamping)

  pages: PageRecord[];
  interactions: InteractionRecord[];
  exceptions: ExceptionRecord[];
  scenarios: Scenario[];
  coverage_summary: CoverageSummary;
  unexplored: UnexploredTask[];

  synthesis_error?: string;         // Present only if final synthesis pass failed
}

type StopReason =
  | 'convergence'       // frontier empty and all agents idle for 30s
  | 'time_cap'          // timeBudgetMs exceeded
  | 'page_cap'          // maxPages reached
  | 'cost_cap'          // maxCcCalls reached
  | 'all_agents_dead';  // all agents crashed before convergence

interface PageRecord {
  url: string;              // Canonical URL as visited
  title: string;            // Document title at time of capture
  domSnapshotPath: string;  // Absolute path to truncated DOM HTML file
  screenshotPath: string;   // Absolute path to full-page PNG
  domHash: string;          // Structural DOM fingerprint (16-char hex); unique key per distinct page structure
  depth: number;            // Navigation hops from baseUrl (baseUrl itself = 0).
                            // HTTP redirects during a single navigation count as 0 additional hops.
                            // Client-side route changes (URL changes) each increment depth by 1.
}

interface InteractionRecord {
  pageUrl: string;          // Page on which interaction was discovered
  hint: string;             // Human-readable description, e.g. "click 'Add to cart' button"
  selector?: string;        // Optional CSS selector if available
  discoveredBy: string;     // Agent identifier. Format: "agent-N" where N is a 1-indexed integer in [1, agentCount].
                            // The same agent instance uses the same identifier for the full run duration.
}

interface ExceptionRecord {
  type: 'console_error' | 'network_4xx' | 'network_5xx';
  url: string;              // URL of the request or page where error occurred
  detail: string;           // e.g. "404 Not Found", or console error message
  pageUrl: string;          // URL of the page the agent was on when captured
}

interface Scenario {
  id: string;               // "S-<N>" e.g. "S-1"
  title: string;            // Human-readable scenario name
  steps: string[];          // Ordered natural-language steps
  assertions: string[];     // What to verify after steps complete
  priority: 'high' | 'medium' | 'low';
  type: 'happy_path' | 'edge_case' | 'error_state' | 'visual_regression';
}

interface CoverageSummary {
  pages_visited: number;
  unique_interactions_tried: number;
  exceptions_found: number;
  scenarios_generated: number;
  cc_calls_used: number;
  elapsed_ms: number;
  stop_reason: StopReason;      // Duplicate of top-level for convenience
  estimated_cost_usd: number;   // Module's best-effort estimate of run cost in USD, computed from
                                 // cc_calls_used × per-call rate. Uses the same rate as costCapUsd conversion.
                                 // Not a billing guarantee; for observability only.
}

interface UnexploredTask {
  url: string;
  interactionHint?: string;
  reason: string;           // e.g. "time_cap reached before processing"
}
```

---

## 4. Behavior Contracts

### B-3-1: Timing guarantee
`exploreUI` returns (resolves or rejects) within `timeBudgetMs + 30_000` milliseconds under all circumstances. The extra 30s covers synthesis, cleanup, and auth-drift recovery. Callers may set their own outer timeout at `timeBudgetMs + 60_000` to allow margin.

### B-3-2: Report always written
When `exploreUI` resolves, `report.coverage_summary` is always present and `report.pages` is an array (may be empty). There is no case where the report is partially constructed on resolve — it is always a complete, schema-valid object.

### B-3-3: Unexplored tasks listed
If exploration ends before the frontier is empty (stop reason: `time_cap`, `page_cap`, `cost_cap`, or `all_agents_dead`), `report.unexplored` contains all tasks that were queued but not processed. If exploration ends via `convergence`, `report.unexplored` is an empty array `[]`.

An `UnexploredTask` represents a queued navigation or interaction unit that was not executed. A URL appearing in `report.pages` was at minimum loaded; its interactions may still appear in `unexplored` if not all were processed (i.e., a URL can appear in both `report.pages` and `report.unexplored`). A URL present in `unexplored` but absent from `report.pages` was never loaded.

### B-3-4: timeBudgetMs enforced across all stop conditions
Regardless of any other stop condition, `report.coverage_summary.elapsed_ms` is always ≤ `timeBudgetMs + 30_000`. This contract holds even if the synthesis pass is running when the time cap triggers — synthesis has its own 60s internal deadline counted inside the +30s margin.

### B-3-5: agentCount clamping, not rejection
If `options.agentCount` is outside the range 1–8, `exploreUI` silently clamps the value (to 1 or 8 respectively) and proceeds. It does NOT reject the Promise. The effective value is reflected in `report.agentCount`.

### B-3-6: Login failure is a pre-flight rejection
If `needLogin=true` and the login sequence fails, `exploreUI` rejects immediately with an `ExplorationError` (code `LOGIN_FAILED`) before any agent starts. No partial report is written.

### B-3-7: Partial success on agent death
If some (but not all) agents die during exploration, `exploreUI` continues with surviving agents. The report is still fully written at the end. `stopReason = 'all_agents_dead'` is set only when the last alive agent dies.

### B-3-8: Synthesis best-effort, non-blocking
If the synthesis pass (scenario generation) fails or times out, `exploreUI` still resolves. The report will have `scenarios: []` and `synthesis_error` set to a non-empty string describing the failure. The `pages`, `interactions`, `exceptions`, and `coverage_summary` fields are unaffected.

### B-3-9: Exception deduplication
Each unique `(type, url, detail)` tuple appears at most once in `report.exceptions`, regardless of how many agents or how many times it was observed.

### B-3-10: Scenario IDs are stable within a run
Within a single `exploreUI` call, scenario IDs (`S-1`, `S-2`, …) are assigned in synthesis order and do not change. Across separate runs (different `runId`), IDs may differ even for semantically similar scenarios.

### B-3-11: domSnapshotPath and screenshotPath are readable files
When `exploreUI` resolves, every path referenced in `report.pages[*].domSnapshotPath` and `report.pages[*].screenshotPath` exists on disk and is readable. If a file could not be written (e.g., disk full), the corresponding `PageRecord` is omitted from `report.pages` entirely rather than included with a broken path.

### B-3-12: baseUrl reachability checked before agent start
`exploreUI` performs a single HTTP GET to `baseUrl` before spawning any agent. If the response does not arrive within 10s, `exploreUI` rejects with `ExplorationError('BASE_URL_UNREACHABLE')`. This prevents N agents all failing on the same unreachable host.

### B-3-13: maxPages counts unique pages only
`report.coverage_summary.pages_visited` counts structurally distinct pages (same page with different data but identical DOM structure is counted once). The `maxPages` stop condition uses this same count.

### B-3-14: costCapUsd and maxCcCalls are independent, both enforced
If both `costCapUsd` and `maxCcCalls` are provided, both caps are enforced. The effective limit is whichever is more restrictive. The cc call counter increments on every AI call regardless of whether it was for interaction suggestion or synthesis.

### B-3-15: projectPath/.localsprite/frontend_test_plan.json written on resolve
When `exploreUI` resolves, the full `ExplorationReport` is also written as JSON to `{projectPath}/.localsprite/frontend_test_plan.json`. The file is created (or overwritten) atomically (write to temp file then rename). If the write fails, `exploreUI` still resolves — the return value is the source of truth.

### B-3-16: estimated_cost_usd is always present and non-negative
`report.coverage_summary.estimated_cost_usd` is always a finite non-negative number when `exploreUI` resolves. It reflects the module's best-effort USD estimate computed from `cc_calls_used` using the same per-call rate as the `costCapUsd` conversion formula. When `costCapUsd` is set, `estimated_cost_usd ≤ costCapUsd` under normal conditions (minor overshoot by at most one call's cost is permitted due to race conditions at cap boundary).

### B-3-17: Login fixture contract
When `needLogin=true` and `loginFixturePath` is provided, the file at that path must be a valid ES module (`.mjs` / `.js` with ESM syntax) that exports a default async function with the signature:

```typescript
export default async function login(page: Page): Promise<void>
```

Where `Page` is a Playwright `Page` object. The function must return (resolve) on successful login. If it throws, `exploreUI` rejects with `ExplorationError('LOGIN_FAILED', { detail: err.message })`.

If `loginFixturePath` points to a non-existent file, `exploreUI` rejects with `ExplorationError('LOGIN_FAILED', { detail: 'fixture file not found' })`.

Auto-detection (when `loginFixturePath` is unset and `needLogin=true`) checks the following paths relative to `projectPath` in order:
1. `tests/fixtures/auth.ts` / `tests/fixtures/auth.mjs`
2. `e2e/fixtures/login.ts` / `e2e/fixtures/login.mjs`
3. `.localsprite/login.ts` / `.localsprite/login.mjs`

If none are found, a heuristic login attempt is made (form-fill). If all heuristics fail, `exploreUI` rejects with `ExplorationError('LOGIN_FAILED')`.

### B-3-18: Synthesis reserved slot and maxCcCalls interaction
The synthesis pass (sonnet call) does NOT count toward the `maxCcCalls` counter. Exploration (haiku) calls are capped strictly at `maxCcCalls`. Synthesis always runs after exploration ends, regardless of whether `maxCcCalls` was exhausted. The only way synthesis is skipped is if it times out or throws (see B-3-8). This means callers can safely set `maxCcCalls=1` and still receive a synthesis attempt.

Rationale: synthesis is a fixed-cost pass (1 call), while `maxCcCalls` governs the variable per-page haiku calls. Counting synthesis in the cap would make `maxCcCalls` semantically confusing.

Note: `coverage_summary.cc_calls_used` reflects only exploration calls. `estimated_cost_usd` includes both exploration and synthesis cost.

### B-3-19: generatedAt timezone
`report.generatedAt` is always a UTC timestamp formatted as `YYYY-MM-DDTHH:mm:ss.sssZ` (Z suffix). Local offsets are never used. Callers may assert `report.generatedAt.endsWith('Z')` and `!isNaN(Date.parse(report.generatedAt))`.

### B-3-20: discoveredBy agent identifier format
`InteractionRecord.discoveredBy` is always of the form `"agent-N"` where `N` is a 1-indexed integer in the range `[1, agentCount]`. The same agent instance uses the same identifier throughout the full run. After agentCount clamping, N values are in `[1, clampedAgentCount]`.

---

## 5. Error Codes

All pre-flight errors reject with an `ExplorationError` instance:

```typescript
class ExplorationError extends Error {
  code: ExplorationErrorCode;
  detail?: string;
}

type ExplorationErrorCode =
  | 'BASE_URL_UNREACHABLE'  // baseUrl did not respond within 10s
  | 'LOGIN_FAILED'          // needLogin=true but login sequence threw or no credentials
  | 'CC_QUOTA_EXCEEDED'     // cc subprocess reported rate-limit/quota error on first call
  | 'ALL_AGENTS_DEAD';      // all agents crashed before any page was visited
                            // (if ≥1 page visited before all die, resolves with partial report instead)
```

Note: `ALL_AGENTS_DEAD` as a rejection only occurs when zero pages have been visited. If at least one page was recorded, `exploreUI` resolves with `stopReason = 'all_agents_dead'`.

---

## 6. Determinism Caveats

`exploreUI` is **non-deterministic** by design:

- LLM-suggested interactions differ across runs even with identical DOM input.
- Navigation timing (network, app render) affects which pages are reached within the time budget.
- Agent scheduling order is non-deterministic.

**Expected repeatability**: Given the same `baseUrl` pointing to the same running app, and the same `timeBudgetMs`, `maxPages`, and `agentCount`:
- `coverage_summary.pages_visited` should be within ±20% across runs.
- Core application pages (reachable via obvious navigation) should appear in `report.pages` in >90% of runs.
- `report.scenarios` titles and steps will vary in phrasing but should cover the same user journeys at >80% overlap across runs.

Callers must not assert exact scenario text equality across separate `exploreUI` invocations.

---

## 7. Cost Disclosure

Rough estimates at default settings (`agentCount=3`, `timeBudgetMs=300_000`, `maxCcCalls=50`):

| Component | Estimated cost |
|---|---|
| Up to 50 AI interaction-suggestion calls (haiku) | ~$0.016 |
| 1 synthesis call (sonnet) | ~$0.003 |
| **Total per run** | **~$0.02** |

Cost is billed to the `claude` CLI process running on the host machine, subject to the user's Claude plan. `localsprite` does not handle billing and does not add markup.

If `costCapUsd` is set and is lower than the above estimate, exploration will stop earlier, producing fewer scenarios.

---

## 8. MCP Tool Binding

`exploreUI` is invoked by the `localsprite_generate_frontend_test_plan` MCP tool handler. The MCP tool's input parameters map to `exploreUI` arguments as follows:

| MCP param | exploreUI arg |
|---|---|
| `projectPath` | `projectPath` |
| `needLogin` | `options.needLogin` |
| (derived from bootstrap) | `baseUrl` |
| (fixed defaults) | remaining options |

The MCP tool handler is responsible for starting the app sandbox and resolving `baseUrl` before calling `exploreUI`. The `exploreUI` function itself has no knowledge of MCP or Docker.

---

## 9. What Is NOT in This Surface

The following are internal implementation details. Test authors must not assume or assert any of these:

- Which browser engine (Chromium, Firefox, WebKit) is used
- How the frontier queue is implemented internally (priority queue, FIFO, etc.)
- The exact claude CLI flags passed to the AI subprocess
- How DOM structural hashing is computed
- Internal agent-to-agent communication mechanism
- The exact HTTP request made for `baseUrl` reachability check
- Internal file paths used for temporary files before atomic rename
- How URL canonicalization handles specific edge cases beyond stated behavior
- The exact prompt sent to the AI for interaction suggestions or synthesis
- How login fixtures are executed internally
