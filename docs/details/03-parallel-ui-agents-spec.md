# Module 03 — Parallel UI Exploration Agents: Dev Spec

> SPEC-SPLIT artifact — dev spec (implementation-facing)
> Module: `src/ui-explore/`
> MCP tool: `localsprite_generate_frontend_test_plan` (tool 4, frontend path)
> Date: 2026-05-26
> Status: draft

---

## 0. Goal

Drive N (default 3, range 1–8) headless Chromium agents in parallel across a running web app. Each agent behaves like a real user: it navigates pages, tries interactions, observes errors, and hands off discoveries to sibling agents. After convergence or timeout, a synthesis pass (sonnet) produces structured test scenarios. The final artifact is `frontend_test_plan.json` plus raw screenshots and DOM snapshots in `~/.localsprite/runs/<runId>/ui-exploration/`.

This replicates TestSprite 3.0's "parallel agents" pitch locally, without cloud infrastructure or API keys.

---

## 1. Constraints & Design Choices

| Dimension | Choice | Rationale |
|---|---|---|
| Browser engine | Playwright headless Chromium | Already a dependency; Chromium == best DevTools protocol support |
| AI engine | `claude --model haiku -p` for per-page interaction suggestions; `claude --model sonnet -p` for final synthesis | Haiku cheap at ~$0.00025/call; sonnet quality for scenario writing |
| Coordination | In-process async frontier (not Redis, not SQLite) | Single process, no network hops; lock-free via `Mutex` from `async-mutex` npm package |
| Dedup | Canonical URL + DOM structural hash | Prevents re-visiting same page via different click paths |
| State persistence | SQLite (`~/.localsprite/db.sqlite`) for run summary; raw files for artifacts | Consistent with other modules |
| Login | Optional; user-provided fixture or auto-detected heuristic | Mirrors TestSprite `needLogin` flag |
| Sandbox relationship | App under test runs INSIDE Docker sandbox; Playwright runs OUTSIDE, connects to sandbox-exposed port | Playwright → `http://localhost:<hostPort>` → Docker port mapping → app |

---

## 2. File Layout

```
src/ui-explore/
  index.ts            ← public entry: exports exploreUI()
  frontier.ts         ← FrontierQueue: async-mutex-guarded task queue
  agent.ts            ← AgentLoop: one Playwright context + one cc subprocess
  dedup.ts            ← canonical URL normalizer + DOM structural hasher
  login.ts            ← login fixture runner (auto-detect + user script)
  synthesis.ts        ← final sonnet pass: scenarios from raw discoveries
  types.ts            ← internal types (FrontierTask, AgentDiscovery, etc.)
  snapshot.ts         ← DOM truncation + screenshot capture helpers
```

External deps used by this module only:
- `playwright` (already in project deps)
- `async-mutex` (new dep, MIT)
- `xxhash-wasm` (fast structural hashing, MIT) — or fallback to `crypto.createHash('md5')` if wasm not available

---

## 3. Core Data Structures

### 3.1 FrontierTask

```typescript
interface FrontierTask {
  id: string;           // uuid v4
  url: string;          // absolute URL (normalized)
  interactionHint?: string; // e.g. "click the 'Add to cart' button"
  depth: number;        // hop count from baseUrl
  sourceAgentId: string;
  enqueuedAt: number;   // Date.now()
}
```

### 3.2 AgentDiscovery

```typescript
interface AgentDiscovery {
  agentId: string;
  taskId: string;
  url: string;
  pageTitle: string;
  domHash: string;          // structural hash (dedup key)
  domSnapshotPath: string;  // file path, ≤50KB truncated HTML
  screenshotPath: string;   // PNG under runDir/screenshots/
  consoleErrors: string[];
  networkErrors: NetworkError[];    // 4xx/5xx responses
  suggestedInteractions: string[];  // from haiku cc call
  timestampMs: number;
}

interface NetworkError {
  url: string;
  status: number;
  method: string;
}
```

### 3.3 ExplorationState (in-process singleton)

```typescript
interface ExplorationState {
  runId: string;
  baseUrl: string;
  frontier: FrontierQueue;
  discoveries: Map<string, AgentDiscovery>; // key = domHash
  visitedUrls: Set<string>;                 // canonical URL set
  agentStatuses: Map<string, AgentStatus>;
  startedAt: number;
  stoppedAt?: number;
  stopReason?: StopReason;
}

type AgentStatus = 'idle' | 'working' | 'dead';
type StopReason = 'convergence' | 'time_cap' | 'page_cap' | 'cost_cap' | 'all_agents_dead';
```

---

## 4. Agent Loop (per agent)

```
┌─────────────────────────────────────────────────────────────┐
│                     AgentLoop (agentId N)                    │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  PULL task from FrontierQueue (await, 30s timeout)   │   │
│  │  If timeout with no task → mark self 'idle'          │   │
│  │  If all agents idle → signal convergence             │   │
│  └────────────────────┬─────────────────────────────────┘   │
│                       │ task pulled                          │
│                       ▼                                      │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  NAVIGATE to task.url (or apply task.interactionHint)│   │
│  │  Playwright page.goto() / locator.click()            │   │
│  │  Wait: networkidle OR 3s timeout                     │   │
│  └────────────────────┬─────────────────────────────────┘   │
│                       │                                      │
│                       ▼                                      │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  CAPTURE                                             │   │
│  │  • URL (after navigation, may differ from task.url)  │   │
│  │  • page.title()                                      │   │
│  │  • DOM snapshot: page.content() truncated to 50KB    │   │
│  │  • consoleErrors: page.on('console') filtered error  │   │
│  │  • networkErrors: route intercept 4xx/5xx            │   │
│  │  • screenshot: page.screenshot({fullPage: true})     │   │
│  └────────────────────┬─────────────────────────────────┘   │
│                       │                                      │
│                       ▼                                      │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  DEDUP CHECK                                         │   │
│  │  domHash = structuralHash(domSnapshot)               │   │
│  │  if domHash in state.discoveries → skip LLM, re-pull │   │
│  └────────────────────┬─────────────────────────────────┘   │
│                       │ new page                             │
│                       ▼                                      │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  ASK haiku cc subprocess                             │   │
│  │  Prompt: "Given this DOM, list 3 interactions a real │   │
│  │  user would try. Return JSON: {interactions:[...]}   │   │
│  │  Each item: {hint: string, selector?: string}"       │   │
│  │  Timeout: 15s hard; if fail → use heuristic fallback │   │
│  │  (find all <a>, <button>, <input> → queue them)      │   │
│  └────────────────────┬─────────────────────────────────┘   │
│                       │                                      │
│                       ▼                                      │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  PUSH to frontier                                    │   │
│  │  For each suggested interaction → FrontierTask       │   │
│  │  Skip if canonical URL already visited               │   │
│  │  Increment cost counter                              │   │
│  └────────────────────┬─────────────────────────────────┘   │
│                       │                                      │
│                       └──────── back to PULL ───────────────┘
│                                                              │
│  EXIT conditions (checked before each PULL):                 │
│  • global stopSignal set (time/page/cost cap)                │
│  • own context closed (error recovery killed this agent)     │
└─────────────────────────────────────────────────────────────┘
```

---

## 5. Frontier Queue Design

`FrontierQueue` wraps a `PriorityQueue<FrontierTask>` (priority = lower depth first) behind an `async-mutex` Mutex.

```typescript
class FrontierQueue {
  private queue: FrontierTask[] = [];
  private mutex = new Mutex();

  async push(task: FrontierTask): Promise<void>
  async pop(): Promise<FrontierTask | null>   // null if empty
  async size(): Promise<number>
  async drain(): Promise<FrontierTask[]>       // returns remaining tasks on stop
}
```

Lock acquisition strategy: each `push` / `pop` acquires the mutex, performs the operation, releases. No reentrant calls. Pop blocks until item available OR 30s timeout (uses `waitForUnlock` with timeout pattern).

Dedup at push time: before enqueuing, check `state.visitedUrls.has(canonicalUrl)`. If yes, drop without enqueue. This is the only place canonicalization happens (single point of truth).

---

## 6. URL Canonicalization & DOM Structural Hash

### 6.1 Canonical URL

1. Parse URL → `new URL(raw)`
2. Remove query params known to be tracking/session-only: `utm_*`, `fbclid`, `gclid`, `_ga`, `sessionId` (configurable blacklist)
3. Sort remaining query params alphabetically
4. Strip trailing slash on path (unless root `/`)
5. Lowercase scheme + host

### 6.2 DOM Structural Hash

Goal: two pages with same structure but different text content (e.g., product detail page for SKU-1 vs SKU-2) should hash the same if structure is identical. Two pages with different components (login vs dashboard) should hash differently.

Algorithm:
1. Extract DOM with `page.evaluate(() => document.documentElement.outerHTML)`
2. Strip text nodes: replace text content with `#TEXT` placeholder
3. Strip all attribute values except `type`, `role`, `aria-*`, `data-testid`
4. Serialize back to string
5. Hash with `crypto.createHash('sha256').update(normalized).digest('hex').slice(0,16)`

This is a best-effort structural fingerprint. False negatives (same structure, different hash) are acceptable — they cause redundant visits but not incorrect results. False positives (different structure, same hash) are not expected given the normalization approach.

---

## 7. Login Handling

### 7.1 Detection Priority

1. User-provided: `options.loginFixturePath` (absolute path to a `.ts` / `.js` / `.mjs` file)
2. Auto-detect: scan `projectPath` for:
   - `tests/fixtures/auth.ts` (Playwright convention)
   - `e2e/fixtures/login.ts`
   - `playwright/setup.ts` with `storageState` export
   - `.localsprite/login.ts`
3. Heuristic: if none found and `needLogin=true`, attempt common patterns:
   - Find `input[type=email]` or `input[name=username]` + `input[type=password]` + submit button
   - Fill with credentials from `projectPath/.localsprite/credentials.json` (if present)
   - If no credentials file: throw `LOGIN_FAILED` with message "no credentials file"

### 7.2 Session Seeding

After login fixture runs in a setup Playwright context:
1. Extract `await context.storageState()` → JSON
2. Create each agent's browser context with `browser.newContext({ storageState })`
3. Agents start with seeded cookies/localStorage

### 7.3 Auth Drift Detection

Each agent, after navigation, checks:
- Response to `page.url()` not redirected to a login-pattern URL (regex: `/login|signin|auth|session-expired/i`)
- If redirected → agent pauses, re-runs login fixture in its own context, resumes

Auth drift recovery is attempted once per agent per run. Second drift → agent marks itself `dead`.

---

## 8. Stopping Conditions

Evaluated in a coordinator loop running every 500ms alongside agents:

```
1. convergence:     frontier.size() == 0 AND all agentStatuses == 'idle' for 30s
2. time_cap:        Date.now() - startedAt >= options.timeBudgetMs          (default 5 * 60 * 1000)
3. page_cap:        state.visitedUrls.size >= options.maxPages               (default 30)
4. cost_cap:        explorationCcCallCount >= options.maxCcCalls             (default 50)
                    NOTE: only exploration (haiku) calls count; synthesis call is excluded from this counter.
5. all_agents_dead: all agentStatuses == 'dead'
```

On stop signal:
1. Set `state.stopReason`
2. Close all Playwright contexts gracefully (each agent checks `stopSignal` before next PULL)
3. Collect `frontier.drain()` → `report.unexplored`
4. Run synthesis pass (section 9)

---

## 9. Synthesis Pass (Sonnet)

After all agents stop, a single `synthesis.ts` call runs:

**Input**: all `AgentDiscovery` records + `standard_prd.json` from projectPath (if available)

**Prompt template** (sent to `claude --model sonnet -p`):
```
You are a QA engineer. Given these UI exploration discoveries from a web app,
synthesize concrete test scenarios. For each scenario, identify:
- the user journey (sequence of pages/interactions)
- what to assert (visible elements, URL, network calls)
- priority (high/medium/low based on coverage of core flows)
- scenario type: happy_path | edge_case | error_state | visual_regression

Return JSON: { "scenarios": [ { "id": "S-N", "title": "...", "steps": [...],
  "assertions": [...], "priority": "...", "type": "..." } ] }
```

**Cost**: one sonnet call. ~$0.003 for typical 4K token response.

**Timeout**: 60s hard. If timeout, report includes `scenarios: []` with `synthesis_error: "timeout"`.

---

## 10. Output Shape

### 10.1 frontend_test_plan.json

Written to `projectPath/.localsprite/frontend_test_plan.json`:

```jsonc
{
  "runId": "run-<uuid>",
  "generatedAt": "<ISO8601>",
  "baseUrl": "http://localhost:3000",
  "stopReason": "convergence | time_cap | page_cap | cost_cap | all_agents_dead",
  "agentCount": 3,

  "pages": [
    {
      "url": "http://localhost:3000/dashboard",
      "title": "Dashboard — MyApp",
      "domHash": "a3f1b2c4d5e6f7a8",
      "domSnapshotPath": "~/.localsprite/runs/<runId>/ui-exploration/snapshots/a3f1b2c4.html",
      "screenshotPath": "~/.localsprite/runs/<runId>/ui-exploration/screenshots/a3f1b2c4.png",
      "depth": 1
      // depth: HTTP redirects during navigation = 0 additional hops; client-side route changes = +1 each
    }
  ],

  "interactions": [
    {
      "pageUrl": "http://localhost:3000/dashboard",
      "hint": "click the 'New Project' button",
      "selector": "button[data-testid='new-project']",
      "discoveredBy": "agent-1"
    }
  ],

  "exceptions": [
    {
      "type": "console_error | network_4xx | network_5xx",
      "url": "http://localhost:3000/api/data",
      "detail": "404 Not Found",
      "pageUrl": "http://localhost:3000/dashboard"
    }
  ],

  "scenarios": [
    {
      "id": "S-1",
      "title": "User creates a new project from dashboard",
      "steps": [
        "Navigate to /dashboard",
        "Click 'New Project' button",
        "Fill in project name",
        "Submit form"
      ],
      "assertions": [
        "URL changes to /projects/<id>",
        "Page title contains project name",
        "No console errors"
      ],
      "priority": "high",
      "type": "happy_path"
    }
  ],

  "coverage_summary": {
    "pages_visited": 12,
    "unique_interactions_tried": 34,
    "exceptions_found": 2,
    "scenarios_generated": 8,
    "cc_calls_used": 42,           // exploration (haiku) calls only; synthesis excluded
    "elapsed_ms": 287430,
    "stop_reason": "convergence",
    "estimated_cost_usd": 0.01875  // cc_calls_used * 0.000375 + 0.003 (synthesis fixed cost)
  },

  "unexplored": [
    {
      "url": "http://localhost:3000/settings/billing",
      "interactionHint": "click 'Upgrade' button",
      "reason": "time_cap reached before processing"
    }
  ]
}
```

### 10.2 Raw Artifacts Directory

```
~/.localsprite/runs/<runId>/ui-exploration/
  snapshots/
    <domHash>.html        ← truncated DOM, UTF-8
  screenshots/
    <domHash>.png         ← full-page PNG
  agent-logs/
    agent-<N>.jsonl       ← one JSON line per discovery event
  synthesis-input.json    ← full discovery array sent to sonnet
  synthesis-output.json   ← raw sonnet response
```

---

## 11. Composition with Docker Sandbox Module

The app under test runs INSIDE a Docker container managed by `src/sandbox/docker.ts`. The parallel UI agents module receives a `baseUrl` that already has the host port mapped by Docker.

```
┌──────────────────────────────────────────────────────────┐
│  Host machine                                            │
│                                                          │
│  ┌──────────────────────┐   http://localhost:hostPort   │
│  │  Playwright (N agents)│ ─────────────────────────────┤
│  │  src/ui-explore/      │                              │
│  └──────────────────────┘                              ┌─┤
│                                                         │ │
│  ┌──────────────────────────────────────────────────┐  │ │
│  │  Docker container (ephemeral)                    │◄─┘ │
│  │  - User's app (port 3000 inside → hostPort out)  │    │
│  │  - Network: isolated bridge, no internet         │    │
│  └──────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────┘
```

The `exploreUI()` function does NOT manage Docker. Callers (tool 4 handler in `src/tools/frontendPlan.ts`) must:
1. Start sandbox via `docker.ts` → obtain `hostPort`
2. Wait for app ready (health-check loop, max 30s)
3. Call `exploreUI({ baseUrl: 'http://localhost:'+hostPort, ... })`
4. Tear down sandbox after `exploreUI` returns

This keeps the ui-explore module sandbox-agnostic (it just needs a URL).

---

## 12. Cost Estimate

At default settings (3 agents, 5 min, 30 pages, 50 cc calls):

| Call type | Count | Model | Cost |
|---|---|---|---|
| Interaction suggestions | ≤50 (maxCcCalls) | haiku | 50 × $0.00025 = $0.0125 |
| Synthesis | 1 | sonnet | ~$0.003 |
| **Total** | | | **~$0.016 per run** |

Haiku pricing basis: $0.25/1M input tokens, $1.25/1M output tokens; estimated 500 input + 200 output tokens per call ≈ $0.000375 per call. Conservative estimate used above.

`coverage_summary.cc_calls_used` counts only exploration (haiku) calls; synthesis is a separate fixed call.
`coverage_summary.estimated_cost_usd` = `cc_calls_used * 0.000375 + 0.003` (haiku exploration + sonnet synthesis fixed cost).

---

## 13. Error Handling

| Error condition | Behavior |
|---|---|
| `baseUrl` unreachable (connection refused) | Throw `ExplorationError('BASE_URL_UNREACHABLE')` before any agent starts |
| Login fixture throws | Throw `ExplorationError('LOGIN_FAILED', {detail: err.message})` |
| Agent Playwright context crashes | Mark agent `dead`; log to `agent-<N>.jsonl`; continue with remaining agents |
| `cc` subprocess non-zero exit | Log warning; use heuristic fallback for that page; decrement `maxCcCalls` by 1 |
| `cc` subprocess quota exceeded | Set `stopReason = 'cost_cap'`; signal coordinator to stop |
| All agents dead before convergence | `stopReason = 'all_agents_dead'`; partial report written |
| Synthesis sonnet call fails | Report includes `scenarios: []`, `synthesis_error: <message>` |
| Disk full writing snapshot | Log warning; skip snapshot write; continue exploration |

---

## 14. Concurrency Safety

- All shared state mutations go through `FrontierQueue.mutex` or are append-only (`Map.set`, `Set.add` are atomic in single-threaded Node.js event loop for non-overlapping keys).
- Agent loops are `async` functions, each running in its own Promise chain. They interleave via `await` points (frontier pop, navigation, cc call). No shared mutable state is written outside mutex except the append-only collections.
- `state.visitedUrls` and `state.discoveries` are written only via helper functions in `index.ts` that run synchronously (no `await` inside the critical section), making them safe under Node.js single-threaded event loop.

---

## 15. Configuration Schema (internal)

```typescript
interface ExploreUIOptions {
  agentCount: number;           // 1–8, default 3
  timeBudgetMs: number;         // default 300_000 (5 min)
  maxPages: number;             // default 30
  maxCcCalls: number;           // default 50
  needLogin: boolean;           // default false
  loginFixturePath?: string;    // absolute path
  costCapUsd?: number;          // optional hard $-cap (converts to maxCcCalls estimate)
  runId?: string;               // auto-generated if not provided
  runDir?: string;              // default ~/.localsprite/runs/<runId>/ui-exploration/
  urlQueryParamBlacklist?: string[]; // additional params to strip during canonicalization
}
```

`costCapUsd` is converted at startup: `maxCcCalls = Math.min(options.maxCcCalls, Math.floor(costCapUsd / 0.000375))`. The more restrictive cap wins.

---

## 16. Module Boundary Contracts (internal, for implementation reference)

These are internal; public-facing contracts are in the public surface doc.

- `frontier.ts` exports only `FrontierQueue` class. Nothing else imports the queue directly.
- `agent.ts` receives `ExplorationState` by reference (shared pointer). Writes go through helper methods only.
- `synthesis.ts` is pure: takes `AgentDiscovery[]`, returns `Scenario[]`. No side effects (caller writes to disk).
- `login.ts` is pure: takes `projectPath + options`, returns `storageState JSON`. No global state.
- `dedup.ts` is pure: takes strings, returns strings/booleans. No I/O.
- `snapshot.ts` is pure: takes Playwright `Page`, returns `{html: string, screenshotBuffer: Buffer}`. No writes.

---

## Appendix A: cc Subprocess Invocation Pattern

```typescript
// In agent.ts — haiku call for interaction suggestions
import { execa } from 'execa';

const prompt = `Given this HTML DOM of a web page, suggest 3 interactions
a real user would try next. Consider buttons, links, forms, inputs.
Return ONLY JSON with this exact shape:
{"interactions": [{"hint": "...", "selector": "..."}]}
No markdown, no explanation.

DOM:
${domSnapshotTruncated}`;

const { stdout } = await execa('claude', ['--model', 'haiku', '-p', prompt], {
  timeout: 15_000,
  stripFinalNewline: true,
});

const parsed = JSON.parse(stdout); // may throw; caller catches → heuristic fallback
```

---

## Appendix B: Structural Hash Reference Implementation

```typescript
import { createHash } from 'crypto';

export function structuralHash(html: string): string {
  // 1. Strip text nodes (replace content between tags with placeholder)
  const noText = html.replace(/>([^<]+)</g, '>#TEXT<');
  // 2. Strip attribute values except type, role, aria-*, data-testid
  const noAttrs = noText.replace(
    /\s(\w[\w-]*)="[^"]*"/g,
    (match, attrName) => {
      const keep = /^(type|role|aria-|data-testid)/.test(attrName);
      return keep ? match : '';
    }
  );
  // 3. Normalize whitespace
  const normalized = noAttrs.replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}
```
