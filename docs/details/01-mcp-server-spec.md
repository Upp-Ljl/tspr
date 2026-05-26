# localsprite MCP Server — Dev Spec (Module 01)

> SPEC-SPLIT artifact — dev-level detail. **Do not hand to test writer.**  
> Companion: `01-mcp-server-public-surface.md`  
> Date: 2026-05-26  
> Status: draft, pending implementation

---

## 0. Purpose & Scope

This document specifies the MCP server module (`src/mcp/` + `src/tools/`) of localsprite.
It covers: transport, bootstrap, tool registry, each of the 8 tools, concurrency, logging,
error handling, process lifecycle, and file layout.

Out of scope for this doc: `ccClient` engine internals, Docker sandbox internals,
browser pool internals, SQLite schema migration logic.

---

## 1. Transport Choice — stdio

**Selection**: `StdioServerTransport` from `@modelcontextprotocol/sdk` v1.x.

**Justification**:
- stdio is the canonical MCP transport for local tools that get spawned by the client
  (Claude Code, Cursor, VS Code, Windsurf). The client forks the process and pipes stdin/stdout.
- stdio avoids port conflict problems inherent to HTTP/SSE transport when multiple projects
  are open simultaneously in the same desktop environment.
- `@modelcontextprotocol/sdk` ships `StdioServerTransport` as a first-class export; HTTP
  transport is experimental in v1.x.
- TestSprite also uses stdio for its local stub process (confirmed via npm package inspection).

**Protocol**: JSON-RPC 2.0 framed over stdio, one request per newline (ndjson).  
**Stdout**: reserved exclusively for the MCP protocol. Never write user-facing text to stdout.  
**Stderr**: all diagnostic logging, startup banners, and error traces go to stderr.

---

## 2. Server Bootstrap

### 2.1 CLI entry point

Binary: `localsprite mcp` (via `package.json` `bin.localsprite` → `dist/cli.js`, which
sub-dispatches to `dist/mcp/server.js`).

Direct execution for development: `node dist/mcp/server.js`.

### 2.2 CLI argument parsing

Parsed by `src/mcp/server.ts` at process startup (before `connect()`):

| Flag | Type | Default | Purpose |
|---|---|---|---|
| `--model` | `string` | `"claude-sonnet-4-5"` | cc subprocess model for code-gen tools |
| `--plan-model` | `string` | `"claude-haiku-4-5"` | cc subprocess model for planning/outline tools |
| `--concurrency` | `number` | `1` | reserved; must be 1 in MVP-0 (validated, throws if >1) |
| `--log-level` | `"debug"\|"info"\|"warn"\|"error"` | `"info"` | stderr verbosity |
| `--config` | `string` | `"~/.localsprite/config.json"` | override config file path |

Unknown flags are ignored with a `warn`-level stderr log (permissive for future extension).

### 2.3 Config file

Path: `~/.localsprite/config.json` (resolved via `os.homedir()`).

If the file exists and is valid JSON, its keys are merged into the runtime config with lower
priority than CLI flags (CLI wins). If the file is missing, the server starts with defaults
and no error is raised (first-run experience).

If the file exists but is not parseable JSON, the server writes a `warn` to stderr and
continues with defaults (defensive; malformed config must not crash the server).

Config schema (all keys optional):

```json
{
  "model": "claude-sonnet-4-5",
  "planModel": "claude-haiku-4-5",
  "dockerImage": "node:24-alpine",
  "browserPoolSize": 3,
  "executeTimeoutMs": 300000,
  "logLevel": "info"
}
```

### 2.4 SQLite initialization

On bootstrap, before `connect()`:

1. Resolve DB path: `~/.localsprite/db.sqlite`.
2. Create parent directory if absent (`fs.mkdirSync({ recursive: true })`).
3. Open DB with `better-sqlite3`; run `PRAGMA journal_mode=WAL;` immediately.
4. Execute `src/state/migrations.ts` which applies schema DDL idempotently using
   `CREATE TABLE IF NOT EXISTS`.
5. Tables: `runs`, `test_results`, `code_summaries` (schema in `docs/details/` of db module).

Failure here is fatal: write error to stderr, `process.exit(1)` with code 1.

### 2.5 Server instantiation and connect

```typescript
const server = new Server(
  { name: "localsprite", version: pkg.version },
  { capabilities: { tools: {} } }
);
server.setRequestHandler(ListToolsRequestSchema, handleListTools);
server.setRequestHandler(CallToolRequestSchema, handleCallTool);
const transport = new StdioServerTransport();
await server.connect(transport);
// from this point stdout is owned by the protocol
```

After `connect()`, write a single `info` line to **stderr**:
```
[localsprite] MCP server started (v<version>, model=<model>, pid=<pid>)
```

---

## 3. Tool Registry

### 3.1 Tool registration pattern

Each tool is a module under `src/tools/<name>.ts` that exports:

```typescript
export interface ToolDefinition {
  name: string;                        // exact MCP tool name
  description: string;                 // shown to MCP client
  inputSchema: z.ZodObject<any>;       // zod schema for validation
  handler: (args: unknown, ctx: ServerContext) => Promise<ToolResult>;
}
```

`src/mcp/registry.ts` imports all 8 `ToolDefinition` objects and exports:
- `TOOL_DEFINITIONS: ToolDefinition[]` — ordered list, used by ListTools
- `TOOL_MAP: Map<string, ToolDefinition>` — keyed by name, used by CallTool dispatch

### 3.2 ListTools handler

Returns the full `TOOL_DEFINITIONS` list serialized per MCP spec:

```typescript
async function handleListTools(): Promise<{ tools: Tool[] }> {
  return {
    tools: TOOL_DEFINITIONS.map(td => ({
      name: td.name,
      description: td.description,
      inputSchema: zodToJsonSchema(td.inputSchema),
    }))
  };
}
```

Library: `zod-to-json-schema` to convert zod → JSON Schema (required by MCP protocol).

### 3.3 CallTool handler and dispatch

```typescript
async function handleCallTool(req: CallToolRequest): Promise<CallToolResult> {
  const td = TOOL_MAP.get(req.params.name);
  if (!td) {
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${req.params.name}`);
  }
  return await callToolMutex.runExclusive(async () => {
    const parsed = td.inputSchema.safeParse(req.params.arguments);
    if (!parsed.success) {
      throw new McpError(ErrorCode.InvalidParams, formatZodError(parsed.error));
    }
    const ctx = buildServerContext();
    const result = await td.handler(parsed.data, ctx);
    return result;
  });
}
```

`callToolMutex` is an `async-mutex` `Mutex` instance (see §5 Concurrency).

---

## 4. Dispatch Flow

```
MCP Client (cc / Cursor / VS Code)
        │
        │  stdin  (JSON-RPC 2.0, ndjson)
        ▼
┌─────────────────────────────────────────────────────────────┐
│  StdioServerTransport (reads stdin, writes stdout)          │
└──────────────────┬──────────────────────────────────────────┘
                   │
        ┌──────────▼──────────┐
        │  Server (MCP SDK)   │
        │  - ListTools        │
        │  - CallTool         │
        └──────────┬──────────┘
                   │
          ┌────────▼────────┐
          │  callToolMutex  │  ← async-mutex, serializes concurrent callers
          └────────┬────────┘
                   │
          ┌────────▼────────┐
          │   registry.ts   │
          │  TOOL_MAP lookup│
          └────────┬────────┘
                   │
     ┌─────────────┼─────────────┐
     │             │             │
  [tool 1]      [tool 6]      [tool 8]
  bootstrap  generateAndExecute  rerun
     │             │             │
     │       ┌─────┼────────┐    │
     │    ccClient  docker  browserPool
     │             │
     └─────────────┘
                   │
          ┌────────▼────────┐
          │  SQLite runs    │  ← log row on every tool completion
          └─────────────────┘
                   │
        stdout  (JSON-RPC response)
```

---

## 5. Concurrency Model

**Single-tenant, single-instance per process.**

MVP-0 constraint: only one CallTool can execute at a time. A second concurrent call from
the same or a different MCP client waits until the first completes.

Implementation: one `Mutex` from `async-mutex` wraps the entire tool handler body inside
`callToolMutex.runExclusive(...)`. The mutex is module-level in `src/mcp/server.ts`.

If a tool's execution exceeds `executeTimeoutMs` (default 300 s), the outer runner cancels
the inner promise via `AbortController` and throws `McpError(ErrorCode.InternalError,
"ERR_TOOL_TIMEOUT")`.

No concurrent Docker containers per tool call: each tool call that needs Docker starts a
fresh ephemeral container and tears it down before returning.

---

## 6. The 8 Tools — Full Specification

### Tool 1: `localsprite_bootstrap_tests`

**Purpose**: Session entry point. Validates the project path exists, detects project type
(frontend/backend/fullstack), checks Docker is running, writes a session record to SQLite.
Returns next-action instructions as a human-readable string.

**Input zod schema**:

```typescript
z.object({
  localPort: z.number().int().min(1).max(65535).default(5173),
  path: z.string().optional(),          // specific route path, e.g. "/dashboard"
  type: z.enum(["frontend", "backend"]),
  projectPath: z.string(),              // absolute path to user project root
  testScope: z.enum(["codebase", "diff"]),
})
```

**Validation logic**:
- `projectPath` must exist on disk (`fs.existsSync`). If not: `ERR_PROJECT_NOT_FOUND`.
- `projectPath` must contain `package.json`. If not: `ERR_NOT_NODE_PROJECT`.
- Docker daemon must be reachable (`dockerode` ping). If not: `ERR_DOCKER_UNAVAILABLE`.
- `localPort` must be in range 1–65535 (enforced by zod).

**Output shape** (returned as MCP `content[0].text`, JSON-encoded string):

```typescript
{
  status: "ok",
  sessionId: string,          // UUID v4, stored in SQLite sessions table
  projectType: "frontend" | "backend" | "fullstack",
  detectedFramework: string,  // e.g. "react+express", "next", "fastify"
  nextAction: string,         // human-readable instruction for cc/Cursor
  warnings: string[],         // non-fatal issues detected
}
```

**File artifacts**: none (state written to SQLite only).

**Error modes**:

| Code | Trigger | User action |
|---|---|---|
| `ERR_PROJECT_NOT_FOUND` | `projectPath` does not exist | Check the path |
| `ERR_NOT_NODE_PROJECT` | No `package.json` in `projectPath` | MVP-0 supports Node only |
| `ERR_DOCKER_UNAVAILABLE` | Docker daemon not reachable | Start Docker Desktop |
| `ERR_INVALID_PORT` | `localPort` out of range (caught by zod) | Use a valid port |

**SQLite**: inserts a `runs` row with `tool = "localsprite_bootstrap_tests"`, `outcome = "ok"` or `"error"`.

---

### Tool 2: `localsprite_generate_code_summary`

**Purpose**: Scans the project, identifies framework, key files, and feature areas. Delegates
heavy analysis to a `cc` subprocess with model=`planModel`. Writes `code_summary.json`.

**Input zod schema**:

```typescript
z.object({
  projectRootPath: z.string(),   // absolute path
})
```

**Validation**: `projectRootPath` must exist and contain `package.json`.

**Processing**:
1. Collect candidate files: `package.json`, `README.md`, top-level `*.ts`/`*.js`/`*.tsx`/`*.jsx`,
   `src/**/*.ts` (max 50 files by line count, sorted largest first).
2. Build a prompt listing file contents (truncated at 4000 chars each) and ask cc to produce
   a JSON code summary.
3. Parse cc stdout as JSON; validate against `CodeSummarySchema` (zod). If invalid, retry once.
4. Write to `{projectRootPath}/.localsprite/code_summary.json`.
5. Store summary in SQLite `code_summaries` table.

**Output shape** (returned as MCP content, also written to disk):

```typescript
{
  status: "ok",
  outputPath: string,        // absolute path to code_summary.json
  framework: string,         // e.g. "react", "express", "nextjs"
  entryPoints: string[],     // key entry files
  featureAreas: { name: string; files: string[] }[],
  dependencies: { name: string; version: string }[],
  testingSetup: string,      // e.g. "vitest", "jest", "none"
}
```

**File artifacts**: `{projectRootPath}/.localsprite/code_summary.json`

**Error modes**:

| Code | Trigger |
|---|---|
| `ERR_PROJECT_NOT_FOUND` | `projectRootPath` does not exist |
| `ERR_NOT_NODE_PROJECT` | Missing `package.json` |
| `ERR_CC_FAILED` | cc subprocess exited non-zero |
| `ERR_CC_OUTPUT_INVALID` | cc output not parseable as expected JSON (after 1 retry) |
| `ERR_WRITE_FAILED` | Cannot write to `.localsprite/` (permissions) |

---

### Tool 3: `localsprite_generate_standardized_prd`

**Purpose**: Reads `code_summary.json` (auto-generates if missing) and produces a structured
PRD JSON containing product overview, user stories, functional + technical requirements.
This serves as the test scope definition for tools 4 & 5.

**Input zod schema**:

```typescript
z.object({
  projectPath: z.string(),   // absolute path to project root
})
```

**Processing**:
1. Read `{projectPath}/.localsprite/code_summary.json`. If missing, invoke tool 2 handler
   internally (not a recursive MCP call—direct function call).
2. Send code summary to cc subprocess (`planModel`) with a prompt that elicits a PRD JSON.
3. Parse and validate against `StandardPrdSchema` (zod).
4. Write to `{projectPath}/.localsprite/standard_prd.json`.

**Output shape**:

```typescript
{
  status: "ok",
  outputPath: string,
  productOverview: string,
  userStories: { id: string; title: string; description: string; priority: "high"|"medium"|"low" }[],
  functionalRequirements: string[],
  technicalRequirements: string[],
}
```

**File artifacts**: `{projectPath}/.localsprite/standard_prd.json`

**Error modes**: same as tool 2 plus `ERR_CODE_SUMMARY_MISSING` (if internal invoke also fails).

---

### Tool 4: `localsprite_generate_frontend_test_plan`

**Purpose**: Runs N=`browserPoolSize` (default 3) Playwright headless browser agents in
parallel. Each agent is driven by one cc subprocess that "acts as a user" exploring the
running app for up to `explorationTimeoutMs` (default 5 min). Aggregates coverage and
writes `frontend_test_plan.json`.

**Input zod schema**:

```typescript
z.object({
  projectPath: z.string(),
  needLogin: z.boolean().default(true),
})
```

**Pre-conditions**:
- The app must be running on `localPort` set during `bootstrap_tests` (looked up from SQLite
  most recent session for this `projectPath`). If no session: `ERR_NOT_BOOTSTRAPPED`.
- Playwright must be installed (checked via `require.resolve('@playwright/test')`). If not:
  `ERR_PLAYWRIGHT_MISSING`.

**Processing**:
1. Look up active session from SQLite to get `localPort` and `type`.
2. Launch N browser instances from `src/sandbox/browserPool.ts`.
3. For each browser, spawn one cc subprocess: prompt = "You are a QA agent. Explore the
   app at `http://localhost:{port}`. Visit all reachable pages, interact with forms, note
   UI patterns and error states. Output JSON: { pages: [...], interactions: [...] }".
4. `Promise.allSettled` on N agents; collect results.
5. Merge: deduplicate pages, union interactions.
6. Send merged coverage to cc (`planModel`) to produce test scenarios.
7. Write to `{projectPath}/.localsprite/frontend_test_plan.json`.

**Output shape**:

```typescript
{
  status: "ok",
  outputPath: string,
  scenarios: {
    id: string;
    title: string;
    type: "navigation"|"form"|"visual-regression"|"interaction";
    steps: string[];
    assertions: string[];
  }[];
  pagesDiscovered: number;
  interactionsDiscovered: number;
}
```

**File artifacts**: `{projectPath}/.localsprite/frontend_test_plan.json`

**Error modes**:

| Code | Trigger |
|---|---|
| `ERR_NOT_BOOTSTRAPPED` | No active session for this project |
| `ERR_PLAYWRIGHT_MISSING` | Playwright not installed in server env |
| `ERR_APP_NOT_REACHABLE` | HTTP GET to `http://localhost:{port}` fails |
| `ERR_CC_FAILED` | Any cc subprocess exits non-zero |
| `ERR_EXPLORATION_TIMEOUT` | All N agents hit timeout with no output |

---

### Tool 5: `localsprite_generate_backend_test_plan`

**Purpose**: Scans the project for Express/Fastify/Next API routes, produces a structured
backend test plan with endpoint list, integration scenarios, auth scenarios, and error cases.

**Input zod schema**:

```typescript
z.object({
  projectPath: z.string(),
})
```

**Processing**:
1. Walk project files: look for `router.get/post/put/delete`, `app.get/post/put/delete`,
   Next `pages/api/**`, Fastify `fastify.route()`. Build route list.
2. Read `standard_prd.json` if present (optional enrichment).
3. Send route list + PRD to cc (`planModel`) to produce test plan JSON.
4. Validate against `BackendTestPlanSchema`.
5. Write to `{projectPath}/.localsprite/backend_test_plan.json`.

**Output shape**:

```typescript
{
  status: "ok",
  outputPath: string,
  scenarios: {
    id: string;
    endpoint: string;          // e.g. "POST /api/users"
    type: "happy-path"|"error"|"auth"|"integration"|"db";
    description: string;
    testHints: string[];       // suggestions for assertions
  }[];
  routesDiscovered: number;
}
```

**File artifacts**: `{projectPath}/.localsprite/backend_test_plan.json`

**Error modes**:

| Code | Trigger |
|---|---|
| `ERR_PROJECT_NOT_FOUND` | `projectPath` does not exist |
| `ERR_NOT_NODE_PROJECT` | No `package.json` |
| `ERR_NO_ROUTES_FOUND` | Zero routes detected (returns warning, not error) |
| `ERR_CC_FAILED` | cc subprocess exits non-zero |

---

### Tool 6: `localsprite_generate_code_and_execute`

**Purpose**: The heaviest tool. Reads the appropriate test plan (`frontend_test_plan.json`
and/or `backend_test_plan.json`), calls cc (`model`) to generate test code, mounts the
user project into a Docker container, runs the tests inside the container, captures results,
and returns a structured report including failure details and fix suggestions.

**Input zod schema**:

```typescript
z.object({
  projectName: z.string(),
  projectPath: z.string(),
  testIds: z.array(z.string()).default([]),         // empty = run all
  additionalInstruction: z.string().default(""),
})
```

**Processing**:

1. **Resolve test plan**: load `frontend_test_plan.json` and/or `backend_test_plan.json`
   from `{projectPath}/.localsprite/`. Filter by `testIds` (if non-empty).
   If neither plan exists: `ERR_NO_TEST_PLAN`.

2. **Cap**: if resolved scenario count > 10, truncate to 10 (first 10) and add a warning.
   This is the MVP-0 cost cap.

3. **Code generation**: for each scenario batch, call cc subprocess (`model`):
   - Frontend scenarios → generate Playwright TypeScript test code.
   - Backend scenarios → generate vitest + supertest TypeScript test code.
   - Output: one `.spec.ts` file per scenario batch, written to temp dir.

4. **Docker execution**:
   a. Pull/verify image: `node:24-alpine` (configurable via `dockerImage`).
   b. `dockerode.createContainer`: bind-mount `projectPath` → `/workspace`, bind-mount
      generated test files → `/tests`.
   c. Run `npm install` inside container (to resolve user deps).
   d. Run `npx vitest run /tests/*.spec.ts --reporter=json` or
      `npx playwright test /tests/*.spec.ts --reporter=json` depending on test type.
   e. Capture `stdout` (test runner JSON) + `stderr` (crash logs).
   f. Stop + remove container via `dockerode` tracker (always, even on error).

5. **Result parsing**:
   - Parse test runner JSON from container stdout.
   - For each failing test: extract `testId`, `stack`, `domSnapshot` (Playwright only),
     `responseBody` (supertest), and compute `suggestedFixRegion` by asking cc haiku
     to identify the file/line range responsible.

6. **Write artifacts**:
   - `{projectPath}/.localsprite/test_results.json`
   - `{projectPath}/.localsprite/report.html` (static HTML wrapping JSON results)
   - Generated `.spec.ts` files: `{projectPath}/.localsprite/generated_tests/`

7. **SQLite**: insert rows into `test_results` for each test case.

**Output shape**:

```typescript
{
  status: "ok" | "partial" | "all-failed",
  outputPath: string,              // path to test_results.json
  reportPath: string,              // path to report.html
  totalTests: number,
  passed: number,
  failed: number,
  skipped: number,
  warnings: string[],
  failures: {
    testId: string;
    title: string;
    stack: string;
    domSnapshot?: string;          // base64 HTML snapshot (frontend only)
    responseBody?: unknown;        // parsed JSON response (backend only)
    suggestedFixRegion: {
      file: string;                // relative to projectPath
      lineStart: number;
      lineEnd: number;
      why: string;
    };
    suggestedPatch?: string;       // unified diff, best-effort
  }[];
}
```

**File artifacts**:
- `{projectPath}/.localsprite/test_results.json`
- `{projectPath}/.localsprite/report.html`
- `{projectPath}/.localsprite/generated_tests/*.spec.ts`

**Error modes**:

| Code | Trigger |
|---|---|
| `ERR_NO_TEST_PLAN` | Neither frontend nor backend plan found |
| `ERR_DOCKER_UNAVAILABLE` | Docker daemon not reachable at execution time |
| `ERR_DOCKER_PULL_FAILED` | Cannot pull Docker image (offline?) |
| `ERR_CONTAINER_CRASH` | Container exited with code ≠ 0 before tests ran |
| `ERR_CC_FAILED` | Code-gen cc subprocess failed |
| `ERR_TOOL_TIMEOUT` | Overall execution exceeded `executeTimeoutMs` |
| `ERR_WRITE_FAILED` | Cannot write artifacts to `.localsprite/` |

---

### Tool 7: `localsprite_open_test_result_dashboard`

**Purpose**: Opens a local static dashboard showing test run history. Returns a `file://`
URL (or `http://localhost:{dashboardPort}` if the embedded HTTP server is active) that
the MCP client can present to the user as a clickable link.

**Input zod schema**:

```typescript
z.object({})   // no required inputs
```

**Processing**:
1. Query SQLite `runs` + `test_results` for last 20 runs.
2. Render to `~/.localsprite/dashboard.html` using a bundled Handlebars template.
3. Embed Playwright trace viewer URL links where trace files exist.
4. Return the `file://` URL.

**Output shape**:

```typescript
{
  status: "ok",
  dashboardUrl: string,     // file:// or http://localhost URL
  runCount: number,
  lastRunAt: string | null, // ISO8601
}
```

**File artifacts**: `~/.localsprite/dashboard.html`

**Error modes**:

| Code | Trigger |
|---|---|
| `ERR_DB_UNINITIALIZED` | SQLite not yet initialized (server bug) |
| `ERR_RENDER_FAILED` | Template rendering failed |

---

### Tool 8: `localsprite_rerun_tests` (beta)

**Purpose**: Reruns the tests from the most recent `generate_code_and_execute` call for
the given project. Uses the existing generated `.spec.ts` files — does not regenerate code.
Produces an updated `test_results.json` and refined report.

**Input zod schema**:

```typescript
z.object({
  projectPath: z.string(),
})
```

**Processing**:
1. Look up the most recent `test_results` run for `projectPath` from SQLite.
   If none: `ERR_NO_PRIOR_RUN`.
2. Verify generated test files still exist in `{projectPath}/.localsprite/generated_tests/`.
   If missing: `ERR_GENERATED_TESTS_MISSING`.
3. Re-execute Docker container with same test files (same flow as tool 6, steps 4–7),
   but skipping code generation step.
4. Write updated `test_results.json` and `report.html`.

**Output shape**: same as tool 6 output shape.

**File artifacts**: updates `{projectPath}/.localsprite/test_results.json` and `report.html`.

**Error modes**:

| Code | Trigger |
|---|---|
| `ERR_PROJECT_NOT_FOUND` | `projectPath` does not exist |
| `ERR_NO_PRIOR_RUN` | No previous `generate_code_and_execute` in SQLite for this project |
| `ERR_GENERATED_TESTS_MISSING` | `.spec.ts` files were deleted |
| `ERR_DOCKER_UNAVAILABLE` | Docker not reachable |
| `ERR_TOOL_TIMEOUT` | Execution exceeded `executeTimeoutMs` |

---

## 7. SQLite Logging — `runs` Table

Every tool call (success or error) appends a row to the `runs` table.

Schema (managed by `src/state/migrations.ts`):

```sql
CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT,                       -- UUID from bootstrap session, nullable
  tool        TEXT NOT NULL,              -- exact tool name
  params_hash TEXT NOT NULL,              -- SHA-256 of JSON.stringify(parsed args)
  started_at  TEXT NOT NULL,             -- ISO8601 UTC
  ended_at    TEXT,                       -- ISO8601 UTC, null if still running
  outcome     TEXT,                       -- "ok" | "error" | "timeout"
  error_code  TEXT,                       -- ERR_* code, null on success
  duration_ms INTEGER                     -- elapsed ms
);
```

The row is inserted with `outcome = NULL` before the handler runs, then updated with
`outcome`, `ended_at`, `duration_ms`, and `error_code` when it returns or throws.

This two-phase write ensures crash-interrupted runs appear in the table as `outcome = NULL`
(detectable as "interrupted").

---

## 8. Error Response Shape (MCP-compliant)

All errors thrown from tool handlers must be `McpError` instances:

```typescript
throw new McpError(
  ErrorCode.InvalidParams,   // or InternalError, MethodNotFound
  "ERR_PROJECT_NOT_FOUND",   // human-readable message
  {                          // structured data field
    code: "ERR_PROJECT_NOT_FOUND",
    projectPath: args.projectPath,
    suggestion: "Verify the path exists and is a Node.js project root.",
  }
);
```

`ErrorCode` mapping:

| Situation | MCP ErrorCode |
|---|---|
| Input validation (zod fail, path missing, not Node project) | `InvalidParams` |
| Unknown tool name | `MethodNotFound` |
| Docker, cc, timeout, write errors | `InternalError` |

The MCP SDK serializes `McpError` into the JSON-RPC error field automatically.

---

## 9. Process Lifecycle & Graceful Shutdown

### 9.1 SIGINT handler

Registered once on `process.once('SIGINT', ...)` and `process.once('SIGTERM', ...)`.

Shutdown sequence:
1. Stop accepting new tool calls: set a global `shuttingDown = true` flag; CallTool handler
   checks this flag and returns `McpError(InternalError, "ERR_SERVER_SHUTTING_DOWN")`.
2. Wait for active tool call to complete (if any) with a 10 s grace period; after 10 s,
   proceed anyway.
3. Tear down all tracked Docker containers via `src/sandbox/docker.ts` `teardownAll()`.
4. Tear down Playwright browser pool via `src/sandbox/browserPool.ts` `destroyAll()`.
5. Close SQLite DB.
6. `process.exit(0)`.

### 9.2 Docker container tracker

`src/sandbox/docker.ts` maintains a module-level `Set<Container>` of currently running
containers. Every `createContainer` call adds to the set; every stop+remove call removes.
On `teardownAll()`, the set is iterated and each container is stopped (force=true) + removed.

This prevents orphan containers if the server crashes mid-execution.

### 9.3 Uncaught exception guard

`process.on('uncaughtException', ...)` writes to stderr and calls `teardownAll()` before
re-throwing (which exits the process). This is a best-effort safety net.

---

## 10. File Layout

```
src/
├── mcp/
│   ├── server.ts          — bootstrap, connect, ListTools + CallTool handlers, mutex
│   └── registry.ts        — TOOL_DEFINITIONS[], TOOL_MAP<string, ToolDefinition>
│
├── tools/
│   ├── bootstrap.ts       — tool 1: localsprite_bootstrap_tests
│   ├── codeSummary.ts     — tool 2: localsprite_generate_code_summary
│   ├── prd.ts             — tool 3: localsprite_generate_standardized_prd
│   ├── frontendPlan.ts    — tool 4: localsprite_generate_frontend_test_plan
│   ├── backendPlan.ts     — tool 5: localsprite_generate_backend_test_plan
│   ├── generateAndExecute.ts — tool 6: localsprite_generate_code_and_execute
│   ├── dashboard.ts       — tool 7: localsprite_open_test_result_dashboard
│   └── rerunTests.ts      — tool 8: localsprite_rerun_tests
│
├── engine/
│   └── ccClient.ts        — cc subprocess wrapper (spawn, timeout, parse stdout)
│
├── sandbox/
│   ├── docker.ts          — dockerode wrapper, container lifecycle, tracker set
│   └── browserPool.ts     — Playwright pool: create N instances, destroyAll
│
├── state/
│   ├── db.ts              — better-sqlite3 singleton, open/init, WAL
│   └── migrations.ts      — idempotent DDL for runs, test_results, code_summaries
│
└── types/
    ├── toolDefinition.ts  — ToolDefinition interface, ServerContext type
    └── schemas.ts         — CodeSummarySchema, StandardPrdSchema, BackendTestPlanSchema, etc.
```

---

## 11. Internal Types

### `ServerContext`

```typescript
interface ServerContext {
  config: ResolvedConfig;         // merged CLI + file config
  db: Database;                   // better-sqlite3 instance
  ccClient: CcClient;             // cc subprocess wrapper
  docker: DockerManager;          // dockerode wrapper
  browserPool: BrowserPool;       // Playwright pool
}
```

### `ToolResult`

Matches MCP SDK `CallToolResult`:

```typescript
interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}
```

Success: `content[0].text` = JSON.stringify of the tool's output shape.  
Error: thrown as `McpError` (SDK turns it into JSON-RPC error; `isError` path not used).

---

## 12. Configuration Precedence (summary)

```
process defaults
    ↓  (overridden by)
~/.localsprite/config.json
    ↓  (overridden by)
CLI flags (--model, --log-level, etc.)
```

---

## 13. Dependency Inventory

| Package | Version constraint | Purpose |
|---|---|---|
| `@modelcontextprotocol/sdk` | `^1.0.0` | MCP server + transport |
| `zod` | `^3.x` | Input validation |
| `zod-to-json-schema` | `^3.x` | Zod → JSON Schema for ListTools |
| `better-sqlite3` | `^12.9.0` | SQLite state |
| `dockerode` | `^4.x` | Docker container lifecycle |
| `playwright` | `^1.x` | Browser pool |
| `async-mutex` | `^0.5.x` | CallTool serialization |
| `uuid` | `^9.x` | Session IDs |

All runtime deps; no test-only packages listed here.
