# tspr MCP Server — Public Surface (Module 01)

> SPEC-SPLIT artifact — **test writer input only**.  
> Rule: this file must be self-sufficient. A reader who has NEVER seen the spec, the source,  
> or any library docs must be able to write meaningful tests for every behavior contract below.  
> DO NOT add implementation details, library names, or internal state structure.  
> Companion dev spec: `01-mcp-server-spec.md` (do not read when writing tests).  
> Date: 2026-05-26

---

## 1. Transport Contract

The tspr MCP server communicates over **stdin/stdout** using newline-delimited JSON-RPC 2.0.

- **stdin** receives JSON-RPC requests from the MCP client.
- **stdout** emits JSON-RPC responses. Stdout carries ONLY protocol frames — no human-readable
  text is ever written to stdout.
- **stderr** receives all diagnostic output (startup messages, log lines). Stderr output is
  informational only and carries no protocol meaning.

Behavior contracts:

**B-0-1**: After the server process starts, it writes at least one line to stderr containing
the string `"MCP server started"` before it begins processing requests.

**B-0-2**: The server responds to a JSON-RPC `tools/list` method with a JSON array of 8
tool definitions. Each entry has at minimum the fields `name` (string) and `inputSchema` (object).

**B-0-3**: No tool invocation, startup message, or log line ever writes non-JSON-RPC content
to stdout.

---

## 2. Tool Name Roster

Exact tool names (case-sensitive). These are the only valid values for the `name` field in a
`tools/call` request:

| # | Tool name |
|---|---|
| 1 | `tspr_bootstrap_tests` |
| 2 | `tspr_generate_code_summary` |
| 3 | `tspr_generate_standardized_prd` |
| 4 | `tspr_generate_frontend_test_plan` |
| 5 | `tspr_generate_backend_test_plan` |
| 6 | `tspr_generate_code_and_execute` |
| 7 | `tspr_open_test_result_dashboard` |
| 8 | `tspr_rerun_tests` |

**B-0-4**: Calling `tools/call` with any name not in the above list returns a JSON-RPC error
with code `-32601` (Method Not Found).

---

## 3. Tool Input Schemas

For each tool, the table lists every parameter: name, type, required/optional, and constraints.
Required parameters with no default must always be supplied; omitting them is an error.

### 3.1 `tspr_bootstrap_tests`

| Parameter | Type | Required | Default | Constraints |
|---|---|---|---|---|
| `localPort` | integer | no | `5173` | 1–65535 inclusive |
| `path` | string | no | _(none)_ | arbitrary route path, e.g. `"/dashboard"` |
| `type` | `"frontend"` \| `"backend"` | **yes** | — | exact enum |
| `projectPath` | string | **yes** | — | absolute filesystem path |
| `testScope` | `"codebase"` \| `"diff"` | **yes** | — | exact enum |

### 3.2 `tspr_generate_code_summary`

| Parameter | Type | Required | Default | Constraints |
|---|---|---|---|---|
| `projectRootPath` | string | **yes** | — | absolute filesystem path |

### 3.3 `tspr_generate_standardized_prd`

| Parameter | Type | Required | Default | Constraints |
|---|---|---|---|---|
| `projectPath` | string | **yes** | — | absolute filesystem path |

### 3.4 `tspr_generate_frontend_test_plan`

| Parameter | Type | Required | Default | Constraints |
|---|---|---|---|---|
| `projectPath` | string | **yes** | — | absolute filesystem path |
| `needLogin` | boolean | no | `true` | — |

### 3.5 `tspr_generate_backend_test_plan`

| Parameter | Type | Required | Default | Constraints |
|---|---|---|---|---|
| `projectPath` | string | **yes** | — | absolute filesystem path |

### 3.6 `tspr_generate_code_and_execute`

| Parameter | Type | Required | Default | Constraints |
|---|---|---|---|---|
| `projectName` | string | **yes** | — | used as label in reports |
| `projectPath` | string | **yes** | — | absolute filesystem path |
| `testIds` | string[] | no | `[]` | empty array = run all |
| `additionalInstruction` | string | no | `""` | freeform guidance for code-gen |

### 3.7 `tspr_open_test_result_dashboard`

No parameters. The input object must be present but may be empty (`{}`).

### 3.8 `tspr_rerun_tests`

| Parameter | Type | Required | Default | Constraints |
|---|---|---|---|---|
| `projectPath` | string | **yes** | — | absolute filesystem path |

---

## 4. Success Return Shapes

Every tool returns its result as a JSON string in `content[0].text`. The caller must
`JSON.parse` that string. All success responses include `"status": "ok"` at the top level.

### 4.1 `tspr_bootstrap_tests` success

```
{
  "status": "ok",
  "sessionId": <string>,           // non-empty UUID
  "projectType": "frontend" | "backend" | "fullstack",
  "detectedFramework": <string>,   // non-empty
  "nextAction": <string>,          // non-empty human-readable instruction
  "warnings": <string[]>           // zero or more non-fatal messages
}
```

### 4.2 `tspr_generate_code_summary` success

```
{
  "status": "ok",
  "outputPath": <string>,          // absolute path to code_summary.json
  "framework": <string>,
  "entryPoints": <string[]>,
  "featureAreas": [{ "name": <string>, "files": <string[]> }, ...],
  "dependencies": [{ "name": <string>, "version": <string> }, ...],
  "testingSetup": <string>         // e.g. "vitest", "jest", "none"
}
```

### 4.3 `tspr_generate_standardized_prd` success

```
{
  "status": "ok",
  "outputPath": <string>,
  "productOverview": <string>,
  "userStories": [{
    "id": <string>,
    "title": <string>,
    "description": <string>,
    "priority": "high" | "medium" | "low"
  }, ...],
  "functionalRequirements": <string[]>,
  "technicalRequirements": <string[]>
}
```

### 4.4 `tspr_generate_frontend_test_plan` success

```
{
  "status": "ok",
  "outputPath": <string>,
  "scenarios": [{
    "id": <string>,
    "title": <string>,
    "type": "navigation" | "form" | "visual-regression" | "interaction",
    "steps": <string[]>,
    "assertions": <string[]>
  }, ...],
  "pagesDiscovered": <integer ≥ 0>,
  "interactionsDiscovered": <integer ≥ 0>
}
```

### 4.5 `tspr_generate_backend_test_plan` success

```
{
  "status": "ok",
  "outputPath": <string>,
  "scenarios": [{
    "id": <string>,
    "endpoint": <string>,          // e.g. "POST /api/users"
    "type": "happy-path" | "error" | "auth" | "integration" | "db",
    "description": <string>,
    "testHints": <string[]>
  }, ...],
  "routesDiscovered": <integer ≥ 0>
}
```

### 4.6 `tspr_generate_code_and_execute` success

```
{
  "status": "ok" | "partial" | "all-failed",
  "outputPath": <string>,           // absolute path to test_results.json
  "reportPath": <string>,           // absolute path to report.html
  "totalTests": <integer ≥ 0>,
  "passed": <integer ≥ 0>,
  "failed": <integer ≥ 0>,
  "skipped": <integer ≥ 0>,
  "warnings": <string[]>,
  "failures": [{
    "testId": <string>,
    "title": <string>,
    "stack": <string>,
    "domSnapshot": <string | undefined>,    // base64 HTML, frontend only
    "responseBody": <any | undefined>,      // backend only
    "suggestedFixRegion": {
      "file": <string>,             // relative to projectPath
      "lineStart": <integer>,
      "lineEnd": <integer>,
      "why": <string>
    },
    "suggestedPatch": <string | undefined>  // unified diff, best-effort
  }, ...]
}
```

### 4.7 `tspr_open_test_result_dashboard` success

```
{
  "status": "ok",
  "dashboardUrl": <string>,        // "file://" or "http://localhost:..." URL
  "runCount": <integer ≥ 0>,
  "lastRunAt": <string | null>     // ISO8601 UTC or null
}
```

### 4.8 `tspr_rerun_tests` success

Same shape as §4.6 (`tspr_generate_code_and_execute` success).

---

## 5. Error Codes

When a tool call fails, the response carries a JSON-RPC error object. The `data` field
of the error contains a structured object with at minimum `"code"` (the `ERR_*` string)
and `"suggestion"` (a user-facing remediation hint).

| Error code | Tools that raise it | When raised | Suggested user action |
|---|---|---|---|
| `ERR_PROJECT_NOT_FOUND` | 1, 2, 3, 5, 8 | `projectPath` / `projectRootPath` does not exist on disk | Verify the path is correct and the directory exists |
| `ERR_NOT_NODE_PROJECT` | 1, 2, 3, 5 | Target directory has no `package.json` | MVP-0 supports Node.js projects only |
| `ERR_DOCKER_UNAVAILABLE` | 1, 6, 8 | Docker daemon is not running or not installed | Start Docker Desktop (or install it) |
| `ERR_INVALID_PORT` | 1 | `localPort` is outside 1–65535 | Supply a valid TCP port number |
| `ERR_CC_FAILED` | 2, 3, 4, 5, 6 | The `claude` CLI subprocess exited with a non-zero status | Check cc CLI is installed and authenticated |
| `ERR_CC_OUTPUT_INVALID` | 2, 3 | cc output could not be parsed as the expected JSON after one retry | Retry; if persistent, file a bug |
| `ERR_WRITE_FAILED` | 2, 3, 4, 5, 6, 7 | Cannot write to `.tspr/` directory | Check filesystem permissions |
| `ERR_NOT_BOOTSTRAPPED` | 4 | No active session found for the given `projectPath` | Call `tspr_bootstrap_tests` first |
| `ERR_PLAYWRIGHT_MISSING` | 4 | Playwright is not installed in the server environment | Install Playwright in the server's environment |
| `ERR_APP_NOT_REACHABLE` | 4 | HTTP GET to the app's port returns no response | Ensure the app is running on the configured port |
| `ERR_EXPLORATION_TIMEOUT` | 4 | All browser agents timed out with no output | Increase timeout or simplify the app |
| `ERR_NO_TEST_PLAN` | 6 | Neither frontend nor backend test plan file exists | Run tool 4 or 5 first |
| `ERR_DOCKER_PULL_FAILED` | 6, 8 | Docker cannot pull the required container image | Check internet connectivity or Docker Hub access |
| `ERR_CONTAINER_CRASH` | 6, 8 | Container exited with non-zero before tests ran | Check the project's npm install or build step |
| `ERR_TOOL_TIMEOUT` | 6, 8 | Execution exceeded the configured timeout | Try with fewer `testIds`; increase timeout in config |
| `ERR_NO_PRIOR_RUN` | 8 | No previous `generate_code_and_execute` recorded for this project | Run tool 6 first |
| `ERR_GENERATED_TESTS_MISSING` | 8 | Generated `.spec.ts` files were deleted since last run | Re-run tool 6 to regenerate them |
| `ERR_DB_UNINITIALIZED` | 7 | SQLite database was not initialized | This is a server startup bug; restart the server |
| `ERR_RENDER_FAILED` | 7 | Dashboard HTML could not be rendered | Retry; if persistent, file a bug |
| `ERR_SERVER_SHUTTING_DOWN` | all | Server received shutdown signal while a call was in-flight | Restart the server and retry |

---

## 6. Behavior Contracts

Numbered contracts for test-writer use. Each contract specifies an observable behavior
testable without knowledge of the implementation.

### Group B-1: `tspr_bootstrap_tests`

**B-1-1**: Calling `tspr_bootstrap_tests` with a `projectPath` that does not exist
on disk returns an error response with `data.code = "ERR_PROJECT_NOT_FOUND"`.

**B-1-2**: Calling `tspr_bootstrap_tests` with a `projectPath` that exists but
contains no `package.json` returns `data.code = "ERR_NOT_NODE_PROJECT"`.

**B-1-3**: Calling `tspr_bootstrap_tests` with a valid Node project path and Docker
running returns a success response where `status = "ok"` and `sessionId` is a non-empty string.

**B-1-4**: The `sessionId` returned by a successful `tspr_bootstrap_tests` call is
unique across calls (two successive calls with the same arguments return different `sessionId` values).

**B-1-5**: Calling `tspr_bootstrap_tests` with `localPort = 0` returns an error
response with `data.code = "ERR_INVALID_PORT"`.

**B-1-6**: Calling `tspr_bootstrap_tests` with `localPort = 65536` returns an error
response with `data.code = "ERR_INVALID_PORT"`.

**B-1-7**: Calling `tspr_bootstrap_tests` with `localPort = 65535` (boundary) and
all other conditions met succeeds (does not raise `ERR_INVALID_PORT`).

**B-1-8**: When Docker is not reachable, `tspr_bootstrap_tests` returns
`data.code = "ERR_DOCKER_UNAVAILABLE"`.

**B-1-9**: Calling `tspr_bootstrap_tests` without the required `type` parameter
returns a JSON-RPC error with code `-32602` (Invalid Params).

**B-1-10**: Calling `tspr_bootstrap_tests` with `type = "frontend"` and a valid
project returns `detectedFramework` as a non-empty string.

---

### Group B-2: `tspr_generate_code_summary`

**B-2-1**: Calling with a non-existent `projectRootPath` returns `data.code = "ERR_PROJECT_NOT_FOUND"`.

**B-2-2**: Calling with a path that has no `package.json` returns `data.code = "ERR_NOT_NODE_PROJECT"`.

**B-2-3**: Successful call returns `status = "ok"` and `outputPath` pointing to an existing
file named `code_summary.json`.

**B-2-4**: The file at `outputPath` is valid JSON after a successful call.

**B-2-5**: `framework` in the response is a non-empty string.

**B-2-6**: `entryPoints` in the response is an array (may be empty for minimal projects).

---

### Group B-3: `tspr_generate_standardized_prd`

**B-3-1**: Calling with a non-existent `projectPath` returns `data.code = "ERR_PROJECT_NOT_FOUND"`.

**B-3-2**: Successful call returns `status = "ok"` and an `outputPath` pointing to an
existing `standard_prd.json` file.

**B-3-3**: The `userStories` array in a successful response is an array (may be empty).

**B-3-4**: Each entry in `userStories` has the fields `id`, `title`, `description`, and
`priority` where `priority` is one of `"high"`, `"medium"`, `"low"`.

**B-3-5**: Calling `tspr_generate_standardized_prd` on a project that has no
pre-existing `code_summary.json` still succeeds (the tool auto-generates the summary internally).

---

### Group B-4: `tspr_generate_frontend_test_plan`

**B-4-1**: Calling without a prior `tspr_bootstrap_tests` call for the given
`projectPath` returns `data.code = "ERR_NOT_BOOTSTRAPPED"`.

**B-4-2**: Calling when the app is not reachable on the configured port returns
`data.code = "ERR_APP_NOT_REACHABLE"`.

**B-4-3**: Successful call returns `status = "ok"`, `outputPath` pointing to an existing
`frontend_test_plan.json`, and `scenarios` as an array.

**B-4-4**: Each scenario in `scenarios` has `id`, `title`, `type`, `steps`, and `assertions` fields.

**B-4-5**: `type` for each scenario is one of `"navigation"`, `"form"`, `"visual-regression"`,
`"interaction"`.

**B-4-6**: `pagesDiscovered` and `interactionsDiscovered` are non-negative integers in
the response.

**B-4-7**: The port used by `tspr_generate_frontend_test_plan` to check app
reachability is the `localPort` from the most recent successful `tspr_bootstrap_tests`
call with the same `projectPath`. If the same project is bootstrapped twice with different
ports, the second (most recent) port is used.

**B-4-8**: Session state created by `tspr_bootstrap_tests` is persisted in
`~/.tspr/tspr.db` and survives server restarts. A `tools/call` to
`tspr_generate_frontend_test_plan` after a server restart still finds sessions
bootstrapped before the restart; `ERR_NOT_BOOTSTRAPPED` is returned only when no
bootstrap record exists in persistent storage for the given `projectPath`.

---

### Group B-5: `tspr_generate_backend_test_plan`

**B-5-1**: Calling with a non-existent `projectPath` returns `data.code = "ERR_PROJECT_NOT_FOUND"`.

**B-5-2**: Successful call returns `status = "ok"` and `outputPath` pointing to an existing
`backend_test_plan.json`.

**B-5-3**: `routesDiscovered` in the response is a non-negative integer.

**B-5-4**: Each scenario in `scenarios` has the fields `id`, `endpoint`, `type`, `description`,
and `testHints`.

**B-5-5**: `type` for each scenario is one of `"happy-path"`, `"error"`, `"auth"`,
`"integration"`, `"db"`.

**B-5-6**: Calling on a project with no detectable routes returns a success response (not
an error); the response includes `routesDiscovered = 0` and an empty `scenarios` array,
plus at least one entry in `warnings`.

---

### Group B-6: `tspr_generate_code_and_execute`

**B-6-1**: Calling when neither `frontend_test_plan.json` nor `backend_test_plan.json`
exists for the given `projectPath` returns `data.code = "ERR_NO_TEST_PLAN"`.

**B-6-2**: Calling with Docker unavailable returns `data.code = "ERR_DOCKER_UNAVAILABLE"`.

**B-6-3**: Successful call returns a response where `totalTests = passed + failed + skipped`.

**B-6-4**: `outputPath` in a successful response points to an existing `test_results.json` file.

**B-6-5**: `reportPath` in a successful response points to an existing `report.html` file.

**B-6-6**: When all tests pass, `status = "ok"` and `failures` is an empty array.

**B-6-7**: When at least one test fails, `failures` contains at least one entry, and each
entry has `testId`, `title`, `stack`, and `suggestedFixRegion` with non-empty `file` and `why`.

**B-6-8**: When `testIds` is a non-empty array, only the specified test IDs are executed;
`totalTests` equals the count of matched IDs (not the full plan size).

**B-6-9**: When the scenario count to execute exceeds 10, the tool executes only the first
10 and includes at least one message in `warnings` indicating truncation.

**B-6-10**: `status` is `"all-failed"` when `passed = 0` and `failed > 0`.

**B-6-11**: `status` is `"partial"` when `passed > 0` and `failed > 0`.

**B-6-12**: After a successful call, no Docker container spawned during the call is still
running (all containers are stopped and removed).

**B-6-13**: Every Docker container spawned by tspr carries the label `tspr=true`.
Callers and tests may enumerate tspr containers (running or stopped) with
`docker ps -a --filter label=tspr` to verify cleanup without interfering with
unrelated Docker activity on the host.

**B-6-14**: When `passed = 0`, `failed = 0`, and `skipped > 0` (all tests were skipped),
`status = "ok"` and `failures` is an empty array. Skipped tests do not constitute a failure.

---

### Group B-7: `tspr_open_test_result_dashboard`

**B-7-1**: Calling with an empty input object `{}` returns `status = "ok"`.

**B-7-2**: `dashboardUrl` in the response is a non-empty string starting with `"file://"` or
`"http://"`.

**B-7-3**: `runCount` is a non-negative integer reflecting the number of completed tool runs
recorded in history.

**B-7-4**: `lastRunAt` is either `null` (no runs yet) or a valid ISO8601 date-time string.

**B-7-5**: `runCount` counts all tool invocations across all 8 tools (both success and
structured-error outcomes) that have a completed row in run history. A call that returned
a JSON-RPC protocol error before execution began (e.g., invalid params, unknown tool) is
NOT counted. A call that reached the tool handler but failed with an `ERR_*` code IS counted.

---

### Group B-8: `tspr_rerun_tests`

**B-8-1**: Calling with a `projectPath` that has no prior `generate_code_and_execute` history
returns `data.code = "ERR_NO_PRIOR_RUN"`.

**B-8-2**: Calling when previously generated test files have been deleted returns
`data.code = "ERR_GENERATED_TESTS_MISSING"`.

**B-8-3**: Successful call returns the same response shape as `tspr_generate_code_and_execute`
(fields: `status`, `outputPath`, `reportPath`, `totalTests`, `passed`, `failed`, `skipped`,
`warnings`, `failures`).

**B-8-4**: After a successful rerun, `outputPath` (`test_results.json`) is updated with a
modification timestamp newer than the previous run's file.

**B-8-5**: Calling with a non-existent `projectPath` returns `data.code = "ERR_PROJECT_NOT_FOUND"`.

**B-8-6**: A rerun executes exactly the `.spec.ts` files produced by the most recent
`tspr_generate_code_and_execute` call for this `projectPath`. If that prior call
used a `testIds` filter, the rerun replays the same scoped subset — it does not expand to
the full test plan. `totalTests` in the rerun response reflects the scoped count, not the
full plan size.

---

### Group B-9: Concurrency

**B-9-1**: When a second `tools/call` request arrives while the first is still executing,
the second request does not return until the first has completed (requests are serialized,
not rejected).

**B-9-2**: Two sequential tool calls (no overlap) both complete successfully; the second
call's result is independent of the first.

---

### Group B-10: Process / Shutdown

**B-10-1**: After the server process starts, a `tools/list` request receives a response
listing exactly 8 tools with the names from §2.

**B-10-2**: Sending SIGINT to the server process while no tool call is in-flight causes the
process to exit with code `0` within 15 seconds.

**B-10-3**: Sending SIGINT while a tool call is in-flight causes the in-flight call to either
complete or receive `data.code = "ERR_SERVER_SHUTTING_DOWN"`, and the process exits with
code `0` within 25 seconds.

**B-10-4**: A `tools/call` sent to a server that has received SIGINT (after the shutdown
signal is processed) returns a JSON-RPC error with `data.code = "ERR_SERVER_SHUTTING_DOWN"`.

---

## 7. File Artifact Contracts

These contracts are observable by inspecting the filesystem after a tool call.

**B-A-1**: After a successful `tspr_generate_code_summary` call, the file
`{projectRootPath}/.tspr/code_summary.json` exists and is valid JSON.

**B-A-2**: After a successful `tspr_generate_standardized_prd` call, the file
`{projectPath}/.tspr/standard_prd.json` exists and is valid JSON.

**B-A-3**: After a successful `tspr_generate_frontend_test_plan` call, the file
`{projectPath}/.tspr/frontend_test_plan.json` exists and is valid JSON.

**B-A-4**: After a successful `tspr_generate_backend_test_plan` call, the file
`{projectPath}/.tspr/backend_test_plan.json` exists and is valid JSON.

**B-A-5**: After a successful `tspr_generate_code_and_execute` call,
`{projectPath}/.tspr/test_results.json` exists, is valid JSON, and contains the
key `"status"` with one of the values `"ok"`, `"partial"`, or `"all-failed"`.

**B-A-6**: After a successful `tspr_generate_code_and_execute` call,
`{projectPath}/.tspr/report.html` exists and has non-zero file size.

**B-A-7**: After a successful `tspr_generate_code_and_execute` call, at least one
`*.spec.ts` file exists under `{projectPath}/.tspr/generated_tests/`.

**B-A-8**: After a successful `tspr_open_test_result_dashboard` call,
`~/.tspr/dashboard.html` exists and has non-zero file size.

---

## 8. Input Validation Contracts

**B-V-0**: Omitting any required parameter for any tool returns a JSON-RPC error with code
`-32602` (Invalid Params), regardless of which tool or which required field is omitted.
This applies uniformly to all 8 tools and all required fields listed in §3.

**B-V-1**: Supplying a string where an integer is required for `localPort` returns a JSON-RPC
error with code `-32602`.

**B-V-2**: Supplying a value not in the allowed enum for `type` (e.g., `"fullstack"`) in
`tspr_bootstrap_tests` returns a JSON-RPC error with code `-32602`.

**B-V-3**: Supplying `testIds` as a non-array value in `tspr_generate_code_and_execute`
returns a JSON-RPC error with code `-32602`.

**B-V-4**: Calling `tspr_open_test_result_dashboard` with any input (including empty
object `{}` and absent input) succeeds; the tool accepts and ignores extra unknown fields.

---

## 9. Error Response Structure

Every error response from a tool has the following JSON-RPC structure:

```
{
  "jsonrpc": "2.0",
  "id": <request id>,
  "error": {
    "code": <integer>,         // -32602 for invalid params, -32603 for internal, -32601 for unknown tool
    "message": <string>,       // ERR_* code as string
    "data": {
      "code": <string>,        // same ERR_* string
      "suggestion": <string>   // non-empty user-facing remediation hint
    }
  }
}
```

**B-E-1**: Every error response has a non-empty `data.suggestion` field.

**B-E-2**: `data.code` matches the `message` field.

**B-E-3**: For input validation errors, `error.code = -32602`.

**B-E-4**: For unknown tool names, `error.code = -32601`.

**B-E-5**: For runtime errors (Docker, cc, timeout, etc.), `error.code = -32603`.

**B-E-6**: `ERR_INVALID_PORT` returns `error.code = -32602` (not -32603). Port range
(1–65535) is a parameter constraint enforced before any business logic or runtime
operations; it is treated as Invalid Params regardless of whether the port is checked by
the schema layer or a downstream range validator.
