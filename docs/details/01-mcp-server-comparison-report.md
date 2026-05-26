# tspr MCP Server — SPEC-SPLIT Comparison Report (Module 01)

> SPEC-SPLIT artifact — step 4 output.
> Author: comparison + patch worker (sonnet).
> Inputs read: `01-mcp-server-spec.md` (868 lines), `01-mcp-server-public-surface.md` (562 lines),
> `01-mcp-server-tests.md` (1287 lines).
> Date: 2026-05-26

---

## 1. Summary Table

| Gap class | Count | Description |
|---|---|---|
| **A** — spec promises X, tests don't cover X | 2 | Gaps logged for test phase; no surface patch needed |
| **B** — tests assume X, surface doesn't expose X | 7 | Real contract holes; all patched in surface this round |
| **C** — spec ↔ surface disagreement | 1 | Unified; surface corrected |
| **Total** | **10** | — |

### Top 5 Highest-Stakes Gaps

| Rank | Gap slug | Why it's high-stakes |
|---|---|---|
| 1 | `invalid-port-rpc-code` | Every test in ERROR-003/005 pairing hits this; wrong assumption breaks all port validation tests |
| 2 | `session-scope-multi-project` | If wrong about persistence, ERR_NOT_BOOTSTRAPPED tests use incorrect setup strategy; entire B-4-1 test class is fragile |
| 3 | `container-label-unknown` | B-6-12 is unverifiable without label; test diffs ALL docker containers — breaks in any non-clean environment |
| 4 | `frontend-plan-port-session-binding` | FEPLAN-002 (ERR_APP_NOT_REACHABLE) is unwritable without knowing which port is checked; multiple-bootstrap scenario ambiguous |
| 5 | `dashboard-runcount-definition` | DASH-003 expected value is unpredictable without knowing which calls increment runCount |

---

## 2. Per-Gap Analysis

---

### GAP: invalid-port-rpc-code
CLASS: B
WHERE TESTS FLAGGED IT: ERROR-005 (NOTES section), BOOTSTRAP-005
WHAT'S MISSING / WRONG: The surface §5 error table lists `ERR_INVALID_PORT` but gives no RPC error code. The §9 error structure description says "-32602 for input validation errors" and "-32603 for runtime errors (Docker, cc, timeout, etc.)". Port range validation (1–65535) is clearly input validation — it's enforced by the zod schema — but the table does not explicitly assign -32602 to `ERR_INVALID_PORT`. The test writer (ERROR-005 NOTES) correctly identified this: BOOTSTRAP-005 pairs it with B-E-3 (-32602), which is right, but the surface doesn't say so explicitly. Any test asserting -32602 or -32603 for ERR_INVALID_PORT is making an assumption the surface doesn't back.
ROOT CAUSE: The surface author wrote the error table before writing §9, then §9 gave the mapping rule as prose without circling back to audit each row in the table. ERR_INVALID_PORT looks superficially like a "business logic" error (port out of range) so it was not explicitly tagged as -32602.
RESOLUTION: Patch surface — add explicit RPC code column to §5 error table, or add a dedicated contract. Adding a contract is cleaner than adding a column (the column would require restructuring a large table).
RESOLUTION REF: surface — new contract B-E-6 added in §9.

---

### GAP: container-label-unknown
CLASS: B
WHERE TESTS FLAGGED IT: EXECUTE-012 (NOTES section)
WHAT'S MISSING / WRONG: B-6-12 says "no Docker container spawned during the call is still running" but gives no way to identify tspr's containers. To test this, a caller must diff ALL Docker containers before/after, which is fragile in environments with other Docker activity. The surface needs to expose the container identification mechanism — a label, name prefix, or network — so tests can filter precisely.
ROOT CAUSE: The surface author wrote B-6-12 from the perspective of the behavior ("containers are cleaned up") without considering how a test or caller would verify it from outside. The implementation detail (docker.ts tracker set) is invisible to the test writer by design, but the observable artifact (container label) should have been promoted to the surface.
RESOLUTION: Patch surface — add contract specifying the Docker label used to identify tspr containers. The spec §9.2 mentions a tracker Set but no label. Adding the label to the surface also drives the implementation to use a consistent label.
RESOLUTION REF: surface — new contract B-6-13 added in Group B-6.

---

### GAP: frontend-plan-port-session-binding
CLASS: B
WHERE TESTS FLAGGED IT: FEPLAN-002 (NOTES), FEPLAN-001 (NOTES)
WHAT'S MISSING / WRONG: `tspr_generate_frontend_test_plan` has no `localPort` parameter; it must read the port from session state. The surface doesn't say: (a) how session state is keyed (by `projectPath`? by `sessionId`?), and (b) if a project is bootstrapped twice with different ports, which port does the frontend plan tool use? FEPLAN-002 (ERR_APP_NOT_REACHABLE) requires the tester to know which port is being probed. Without this contract, the test setup is ambiguous.
ROOT CAUSE: The surface author wrote B-4-1 (ERR_NOT_BOOTSTRAPPED) and B-4-2 (ERR_APP_NOT_REACHABLE) without documenting the session lookup rule. The lookup logic is in the spec (§6 tool 4: "Look up active session from SQLite to get localPort and type"), but the surface omitted the keying rule.
RESOLUTION: Patch surface — add contract specifying that the port is taken from the most recent successful bootstrap for the same `projectPath`.
RESOLUTION REF: surface — new contract B-4-7 added in Group B-4.

---

### GAP: rerun-test-id-filtering
CLASS: B
WHERE TESTS FLAGGED IT: RERUN-003 (NOTES)
WHAT'S MISSING / WRONG: `tspr_rerun_tests` has only `projectPath` as a parameter (no `testIds`). The surface says rerun has "same shape" as tool 6 output. But the surface does not specify what happens when the prior `generate_code_and_execute` call used a `testIds` filter: does rerun replay only those IDs? Or does it run the full plan? This is a real behavioral decision a caller needs to know.
ROOT CAUSE: The surface author described the rerun output shape but not its scope definition. The spec §6 tool 8 says "Uses the existing generated .spec.ts files — does not regenerate code" — the generated files reflect whatever subset was generated in the prior run. But this chain of inference is not in the surface.
RESOLUTION: Patch surface — add contract explicitly stating that rerun executes exactly the same test files produced by the most recent `generate_code_and_execute` call, including any testIds scoping that was active.
RESOLUTION REF: surface — new contract B-8-6 added in Group B-8.

---

### GAP: session-scope-multi-project
CLASS: B
WHERE TESTS FLAGGED IT: FEPLAN-001 (NOTES), GAP section §4
WHAT'S MISSING / WRONG: The surface does not say whether session state from `tspr_bootstrap_tests` is persisted across server restarts (SQLite-backed) or lost on process exit (in-memory). This matters critically for test setup: if sessions are in-memory, a test for ERR_NOT_BOOTSTRAPPED just needs a fresh server process with a new projectPath; if sessions are persisted in SQLite, a test must use a projectPath that has never been bootstrapped in any server run.
ROOT CAUSE: The surface author assumed test writers would infer from the startup description that the server initializes SQLite. But "SQLite is initialized" does not tell the test writer what is stored in it or whether sessions are one of those things. The spec §2.4 and §7 are clear (SQLite stores runs, test_results, code_summaries — not sessions explicitly), but sessions are a `runs` table concept via `session_id`. The surface omitted the persistence scope.
RESOLUTION: Patch surface — add contract clarifying that session state is persisted in SQLite and survives server restarts, so ERR_NOT_BOOTSTRAPPED is keyed by projectPath presence in persistent state.
RESOLUTION REF: surface — new contract B-4-8 added in Group B-4.

---

### GAP: dashboard-runcount-definition
CLASS: B
WHERE TESTS FLAGGED IT: DASH-003 (NOTES), GAP section §4
WHAT'S MISSING / WRONG: B-7-3 says "`runCount` is a non-negative integer reflecting the number of completed tool runs recorded in history." "Completed tool runs" is ambiguous: does it count all 8 tools, or only `generate_code_and_execute` + `rerun_tests`? Does it count failed calls that returned a structured error (vs. a JSON-RPC protocol error before execution began)? A test that fires a failing `bootstrap` call and then checks `runCount` needs to know whether that increments the count.
ROOT CAUSE: The surface author wrote B-7-3 describing the shape but not the counting rule. The spec §7 says "every tool call (success or error) appends a row to the runs table" — implying all tools are counted, including errors. But the surface didn't carry this precision into B-7-3.
RESOLUTION: Patch surface — add contract clarifying that `runCount` counts all tool calls (all 8 tools, success and error outcomes) that have a completed row in the run history.
RESOLUTION REF: surface — new contract B-7-5 added in Group B-7.

---

### GAP: bootstrap-missing-required-testscope
CLASS: B
WHERE TESTS FLAGGED IT: BOOTSTRAP-009 (NOTES), GAP section §4
WHAT'S MISSING / WRONG: B-1-9 specifically says omitting `type` returns -32602. But the surface has no general contract covering all required parameters across all 8 tools. A test writer wondering "what does omitting `projectPath` from tool 3 return?" has no surface contract — only the implied behavior from the JSON Schema validation. Without an explicit general contract, tests for other missing-required-field cases have no surface anchor.
ROOT CAUSE: The surface author wrote a specific contract for `type` (because it's an enum and was being tested explicitly) without generalizing it to all required fields. The §8 Input Validation Contracts section covers type mismatches (B-V-1/2/3) but not missing required fields in general.
RESOLUTION: Patch surface — add a general contract (B-V-0) that any omitted required field from any tool returns -32602. This is already implied by the JSON Schema contract but needs to be explicit.
RESOLUTION REF: surface — new contract B-V-0 added in §8.

---

### GAP: generate-frontend-needlogin-default
CLASS: A
WHERE TESTS FLAGGED IT: GAP section §4 (gap 8: `generate-frontend-needlogin-default`)
WHAT'S MISSING / WRONG: The surface lists `needLogin` as an optional parameter with default `true` but provides no behavioral contract for what changes when it's `false`. A test writer cannot write a test asserting the observable difference between `needLogin = true` and `needLogin = false`.
ROOT CAUSE: The spec §6 tool 4 includes `needLogin` in the zod schema but does not describe its behavioral effect on scenario generation. The surface faithfully copied the parameter table but had nothing to describe for the behavior. This is a spec-level gap (the behavior was not designed in detail for MVP-0).
RESOLUTION: Deferred. This is a Class A gap — spec is also silent on the observable behavioral difference. The implementation needs to decide the behavior before a surface contract can be written. Tracked in Deferred Punch List §5.
RESOLUTION REF: deferred, tracked in §5.

---

### GAP: spec-tool6-status-logic-inconsistency (additional, found during cross-reference)
CLASS: C
WHERE TESTS FLAGGED IT: EXECUTE-006/010/011 cross-check
WHAT'S MISSING / WRONG: Surface B-6-10 says `status = "all-failed"` when `passed = 0` AND `failed > 0`. B-6-11 says `status = "partial"` when `passed > 0` AND `failed > 0`. Neither contract covers the case where `skipped > 0` and `failed = 0` and `passed = 0` (all tests skipped). The `status` logic as stated does not cover all cases, leaving the `skipped`-only scenario undefined. Spec §6 tool 6 output shape shows three status values (`"ok" | "partial" | "all-failed"`) but doesn't define the skipped-only case either.
ROOT CAUSE: Neither spec nor surface author considered the degenerate case where all tests are skipped (a valid test runner outcome). The surface has three status values but only two are constrained by contracts.
RESOLUTION: Patch surface — add contract B-6-14 clarifying the `status` value when `passed = 0`, `failed = 0`, and `skipped > 0`.
RESOLUTION REF: surface — new contract B-6-14 added in Group B-6.

---

### GAP: spec-unknown-flags-behavior-not-surfaced (additional, found during cross-reference)
CLASS: A
WHERE TESTS FLAGGED IT: Not in test doc; found during spec cross-reference
WHAT'S MISSING / WRONG: Spec §2.2 states "Unknown flags are ignored with a `warn`-level stderr log." This is an observable behavior (server emits a warn to stderr for unknown CLI flags) but has no surface contract and no test covers it.
ROOT CAUSE: The surface author focused on the runtime MCP protocol and omitted CLI flag handling behaviors from the surface. It's a valid observable behavior but not critical for tool-call tests.
RESOLUTION: Deferred. This is a Class A gap — the spec defines it, tests don't cover it. It's observable via stderr capture during server startup. Tracked in Deferred Punch List §5.
RESOLUTION REF: deferred, tracked in §5.

---

## 3. Patches Applied This Round

All patches are to `01-mcp-server-public-surface.md`. No spec changes were required (the class-C gap was surface-only).

| Surface location | Change | Why |
|---|---|---|
| §9, after B-E-5 | Added B-E-6: ERR_INVALID_PORT uses -32602 | Gap `invalid-port-rpc-code` — Class B |
| §6 Group B-4, after B-4-6 | Added B-4-7: port lookup uses most-recent-bootstrap for projectPath | Gap `frontend-plan-port-session-binding` — Class B |
| §6 Group B-4, after B-4-7 | Added B-4-8: session state is SQLite-persisted, survives restarts | Gap `session-scope-multi-project` — Class B |
| §6 Group B-6, after B-6-12 | Added B-6-13: tspr Docker containers labeled with `tspr=true` | Gap `container-label-unknown` — Class B |
| §6 Group B-6, after B-6-13 | Added B-6-14: status when all tests skipped | Gap `spec-tool6-status-logic-inconsistency` — Class C |
| §6 Group B-7, after B-7-4 | Added B-7-5: runCount definition (all tool calls, success+error) | Gap `dashboard-runcount-definition` — Class B |
| §6 Group B-8, after B-8-5 | Added B-8-6: rerun replays same test file set as prior generate_code_and_execute | Gap `rerun-test-id-filtering` — Class B |
| §8, before B-V-1 | Added B-V-0: general missing-required-field → -32602 contract | Gap `bootstrap-missing-required-testscope` — Class B |

---

## 4. New Contracts Added to Surface

| Contract | One-line summary |
|---|---|
| B-E-6 | `ERR_INVALID_PORT` returns JSON-RPC error code -32602 (not -32603) because port range is a parameter constraint |
| B-4-7 | Frontend plan tool reads the port from the most recent successful bootstrap call with the same `projectPath` |
| B-4-8 | Bootstrap session state is persisted in SQLite and survives server restarts; session lookup for B-4-1 is against persistent state |
| B-6-13 | Every Docker container spawned by tspr carries the label `tspr=true`; use `docker ps -a --filter label=tspr` to enumerate them |
| B-6-14 | When `passed = 0`, `failed = 0`, and `skipped > 0`, `status = "ok"` (no failures occurred) |
| B-7-5 | `runCount` counts all tool invocations (all 8 tools, success and structured-error outcomes) that have a completed row in run history; JSON-RPC errors returned before execution began are not counted |
| B-8-6 | A rerun executes exactly the `.spec.ts` files generated by the most recent `generate_code_and_execute` call for this `projectPath`, including any `testIds` scoping that was active in that call |
| B-V-0 | Omitting any required parameter for any tool returns a JSON-RPC error with code -32602, regardless of which tool or which required field is omitted |

---

## 5. Deferred Punch List

### Class A gaps (spec defines, tests don't cover — left for implementation/test phase)

| Gap slug | Why deferred | What tests should eventually cover |
|---|---|---|
| `generate-frontend-needlogin-default` | Spec is also silent on the observable behavioral difference. The implementation must decide what `needLogin=false` changes before a surface contract can be written. | Test: two calls with identical project, one `needLogin=true`, one `needLogin=false`; assert scenario type distribution differs (login-related `form` scenarios absent in `false` case). Surface contract needed first. |
| `spec-unknown-flags-behavior-not-surfaced` | CLI flag behavior is observable (stderr warn) but not critical for MCP tool-call correctness tests. Low priority for MVP-0. | Test: spawn server with `--unknownFlag foo`; assert stderr contains a `warn`-level line within 5 seconds. |

### Class B gaps that could not be patched this round

None. All 7 class-B gaps from the test doc were patched. The 1 additional class-B found during cross-reference (status-logic-inconsistency, treated as class-C after spec check) was also resolved.

---

## 6. Cross-Reference Verification

Every B-* contract in the surface was checked against the Coverage Map (test doc §2). All 62 existing contracts (B-0-1 through B-E-5) have at least one named test. The 8 new contracts added this round will require new tests to be written during the implementation phase; they are logged here as the test author's TODO list.

| New contract | Suggested test name |
|---|---|
| B-E-6 | ERROR-006: ERR_INVALID_PORT returns -32602 not -32603 |
| B-4-7 | FEPLAN-007: double-bootstrap different ports; plan tool uses second port |
| B-4-8 | FEPLAN-008: restart server after bootstrap; frontend plan finds session |
| B-6-13 | EXECUTE-013: containers labeled tspr=true appear in docker filter before call returns |
| B-6-14 | EXECUTE-014: all-skipped run returns status=ok |
| B-7-5 | DASH-005: failed bootstrap call increments runCount |
| B-8-6 | RERUN-006: rerun after filtered execute (testIds=[x]) reruns only x |
| B-V-0 | VALIDATE-005: omitting required projectPath from tool 3 returns -32602 |
