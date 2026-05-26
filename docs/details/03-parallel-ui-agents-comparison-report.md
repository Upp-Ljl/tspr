# Module 03 — Parallel UI Exploration Agents: SPEC-SPLIT Comparison Report

> SPEC-SPLIT Step 4 artifact
> Module: `src/ui-explore/`
> Date: 2026-05-26
> Inputs:
>   - `03-parallel-ui-agents-spec.md` (549 lines, dev spec)
>   - `03-parallel-ui-agents-public-surface.md` (258 lines, blackbox surface)
>   - `03-parallel-ui-agents-tests.md` (946 lines, independent blackbox test doc)
> Method: Knight-Leveson N-version independent authorship

---

## 0. Summary

| Class | Count | Description |
|---|---|---|
| A | 3 | Spec promises not exercised in tests |
| B | 7 | Tests assume contract that surface did not expose (real surface gaps) |
| C | 1 | Dev spec and public surface disagree; unification required |
| **Total** | **11** | |

All Class-B gaps have been patched into the public surface as new B-3-* contracts.
The Class-C gap has been unified in both spec and surface.

---

## 1. Class-A Gaps — Spec Promises Not in Tests

These are behaviors the spec documents but the test doc author did not write a test for.
They represent **missing coverage**, not surface gaps.

---

### A-1: Auth drift mid-run recovery (spec §7.3)

**Spec says**: After successful login, if an agent detects it has been redirected to a login URL
mid-exploration (regex `/login|signin|auth|session-expired/i`), it pauses, re-runs the login
fixture in its own context, then resumes. Second drift → agent marks itself `dead`.

**Tests cover**: Only B-3-6 (login failure at startup). No test exercises the scenario where login
succeeds initially but a session expires mid-run.

**Risk**: Auth drift is a real-world failure mode. Without a test, the re-login logic is
unverifiable without manual exploration.

**Recommendation**: Add `TEST: auth-drift-mid-run-re-login` and `TEST: auth-drift-second-occurrence-kills-agent`.
Fixture: a demo app whose session cookie expires after 5 seconds.

---

### A-2: URL canonicalization query-param blacklist (spec §6.1)

**Spec says**: `urlQueryParamBlacklist` option allows callers to add additional query params to the
built-in strip list (`utm_*`, `fbclid`, `gclid`, `_ga`, `sessionId`). These are removed before
dedup and frontier push.

**Tests cover**: No test for `urlQueryParamBlacklist` option. The option was not even in the
original surface options table (now added as part of this report's Class-C fix — see C-1).

**Risk**: If a test app uses session-tracking params that cause spurious dedup misses, this
option is untestable. Coverage gap for the canonical URL function.

**Recommendation**: Add `TEST: url-canonicalization-blacklist-strips-custom-params`. Can be
unit-level (test `dedup.ts` directly or via observable `pages.length` reduction).

---

### A-3: cc subprocess non-zero exit → heuristic fallback (spec §13)

**Spec says**: If a `cc` subprocess exits non-zero (any reason other than quota exceeded), the
agent logs a warning, uses the heuristic fallback (find all `<a>`, `<button>`, `<input>` elements),
and decrements `maxCcCalls` by 1.

**Tests cover**: `TEST: cc-quota-exceeded-pre-flight-rejection` covers quota exceeded on the
**first** call. No test covers a mid-run non-zero exit where exploration should continue with
fallback.

**Risk**: The heuristic fallback path may have bugs that are only triggered after N successful
calls. Untested.

**Recommendation**: Add `TEST: cc-subprocess-transient-failure-uses-fallback`. Mock cc to fail on
call #2 (not first); assert exploration continues and `report.pages.length ≥ 1`.

---

## 2. Class-B Gaps — Tests Assume Contract Surface Didn't Expose

These are the most valuable findings: the independent test author needed a contract that was
absent or ambiguous in the surface. Each has been patched into the public surface.

---

### B-1: `estimated_cost_usd` not in report → B-3-16 added

**Test comment** (line 622): "GAP: report does not expose actual_cost_usd so we cannot assert
the cap was honoured in dollar terms."

**Why a real gap**: `costCapUsd` is an option callers use to bound cost. Without a field
reflecting estimated cost, callers and tests can only observe `cc_calls_used` (a proxy). A
test wanting to assert `costCapUsd=0.005` was respected has no direct observable.

**Surface patch**:
- Added `estimated_cost_usd: number` to `CoverageSummary` interface
- Added B-3-16: "When `costCapUsd` is set, `estimated_cost_usd ≤ costCapUsd` under normal conditions
  (minor overshoot by at most one call's cost permitted due to race at cap boundary)."
- Added formula to spec §12: `estimated_cost_usd = cc_calls_used * 0.000375 + 0.003`

**Files patched**: `03-parallel-ui-agents-public-surface.md`, `03-parallel-ui-agents-spec.md`

---

### B-2: Login fixture export contract undefined → B-3-17 added

**Test comment** (lines 902–906): "COULD NOT ASSERT: Exactly what interface a login fixture
script must export or execute; what 'auto-detection' tries; what constitutes a login success
vs. failure signal from the fixture."

**Why a real gap**: Tests `login-happy-path`, `login-fixture-path-missing-file`, and
`login-auto-detect-no-fixture-path` all require knowing what a valid fixture looks like to write
the fixture helper. Without a contract, fixture files written for tests may accidentally comply
or fail for implementation reasons that change without notice.

**Surface patch**: Added B-3-17 with:
- Required export signature: `export default async function login(page: Page): Promise<void>`
- Behavior on missing file: `LOGIN_FAILED` with `detail: 'fixture file not found'`
- Auto-detection search order (3 paths relative to `projectPath`)
- Fallback to heuristic then `LOGIN_FAILED` if all fail

**Files patched**: `03-parallel-ui-agents-public-surface.md`

---

### B-3: Synthesis vs. maxCcCalls counter semantics → B-3-18 added

**Test comment** (lines 910–914): "COULD NOT ASSERT: Whether `maxCcCalls=N` leaves room for
synthesis or if synthesis can be 'crowded out'... no contract specifies what happens when
`maxCcCalls` is reached mid-synthesis."

**Why a real gap**: Surface B-3-14 (original) said "cc call counter increments on every AI
call regardless of whether it was for interaction suggestion or synthesis." This made it
impossible to write a test for `maxCcCalls=3` that could reliably expect synthesis to run —
if synthesis counts as call #4, it would be suppressed. This was the single most impactful
ambiguity for testability.

**Resolution (policy decision)**: Synthesis does NOT count toward `maxCcCalls`. The counter
tracks only exploration (haiku) calls. Synthesis always runs after exploration ends. This makes
`maxCcCalls` semantically clean and synthesis reliably available.

**Surface patch**: Added B-3-18; updated B-3-14 wording to remove "or synthesis."
**Spec patch**: Updated §8 stopping condition 4 to use `explorationCcCallCount`; added clarifying
note. Updated §12 to note `cc_calls_used` excludes synthesis.
**Note**: This is also Class C (resolves a spec/surface disagreement) — counted here, not double-
counted in Section 3.

**Files patched**: `03-parallel-ui-agents-public-surface.md`, `03-parallel-ui-agents-spec.md`

---

### B-4: `PageRecord.depth` undefined for redirects → B-3-19 (depth rule in PageRecord)

**Test comment** (lines 918–922): "COULD NOT ASSERT: What `depth` value is assigned to a page
reached via HTTP redirect… Does following a redirect count as 1 hop?"

**Why a real gap**: `TEST: happy-path-full-exploration` asserts `at least one page has depth === 0`.
If `http://localhost:5173/` redirects to `http://localhost:5173/home`, the tester cannot know
whether `depth` is 0 or 1 for `/home`.

**Surface patch**: Updated `PageRecord.depth` inline comment:
- "HTTP redirects during a single navigation count as 0 additional hops."
- "Client-side route changes (URL changes) each increment depth by 1."

**Files patched**: `03-parallel-ui-agents-public-surface.md`

---

### B-5: `InteractionRecord.discoveredBy` format not pinned → B-3-20 added

**Test comment** (lines 926–930): "COULD NOT ASSERT: The exact format of
`InteractionRecord.discoveredBy` — is it always 'agent-N' with N being 1-indexed?"

**Why a real gap**: Tests verifying multi-agent correctness (e.g., `TEST: partial-agent-death-
continues`) may want to assert which agents contributed discoveries. Without a pinned format,
assertions like `report.interactions.some(i => i.discoveredBy === 'agent-2')` are speculative.

**Surface patch**:
- Updated `InteractionRecord.discoveredBy` inline doc: "Format is `'agent-N'` where N is a
  1-indexed integer in `[1, agentCount]`. The same agent instance uses the same identifier for
  the full run duration."
- Added B-3-20 as a formal contract.

**Files patched**: `03-parallel-ui-agents-public-surface.md`

---

### B-6: `generatedAt` timezone not specified → B-3-19 added (generatedAt contract)

**Test comment** (lines 933–938): "COULD NOT ASSERT: Whether `report.generatedAt` is always UTC
or may be local time; whether it uses `Z` suffix."

**Why a real gap**: `TEST: report-schema-complete-on-resolve` asserts `generatedAt` is "a
parseable ISO 8601 string." ISO 8601 allows local offsets. Tests on CI machines in different
timezones could behave differently if the implementation uses local time.

**Surface patch**:
- Updated `ExplorationReport.generatedAt` inline comment to: "UTC ISO 8601 timestamp, always
  ends with 'Z' (e.g. "2026-05-26T12:00:00.000Z")"
- Added B-3-19 as a formal contract.

**Files patched**: `03-parallel-ui-agents-public-surface.md`

---

### B-7: `unexplored` vs `pages` overlap semantics → B-3-3 extended

**Test comment** (lines 941–946): "COULD NOT ASSERT: Whether a URL can appear in both
`report.pages` and `report.unexplored`."

**Why a real gap**: `TEST: unexplored-populated-on-time-cap` accesses `report.unexplored` and
iterates URLs. Without knowing whether a URL can be in both collections, a test asserting
"unexplored URLs are not visited pages" would be wrong by assumption.

**Surface patch**: Extended B-3-3 with:
- A URL can appear in both `pages` and `unexplored` (page was loaded; its interactions were queued
  but not processed).
- A URL in `unexplored` but NOT in `pages` was never loaded.

**Files patched**: `03-parallel-ui-agents-public-surface.md`

---

## 3. Class-C Gaps — Spec and Surface Disagree

---

### C-1: `urlQueryParamBlacklist` in spec internal config but absent from surface options

**Spec says** (§15): `ExploreUIOptions` includes `urlQueryParamBlacklist?: string[]`.

**Surface said**: Options table did not include this field. Callers reading only the surface
would not know this option exists.

**Why this matters**: The surface is meant to be the complete caller-facing contract. A missing
option means callers cannot use the feature, and tests cannot cover it.

**Resolution**: Added `urlQueryParamBlacklist` to the public surface options table with type
`string[] | undefined`, default `undefined`, and description matching spec §6.1 intent.

**Files patched**: `03-parallel-ui-agents-public-surface.md`

---

## 4. New B-3-* Contracts Added to Surface

| ID | Slug | Description |
|---|---|---|
| B-3-16 | `estimated-cost-usd-present` | `estimated_cost_usd` always present, non-negative; ≤ costCapUsd when cap set |
| B-3-17 | `login-fixture-contract` | ESM default-export `async function login(page)`, missing-file → LOGIN_FAILED, auto-detect search order |
| B-3-18 | `synthesis-not-counted-in-maxCcCalls` | Synthesis call excluded from maxCcCalls counter; always runs post-exploration |
| B-3-19 | `generatedAt-utc-z-suffix` | Always `YYYY-MM-DDTHH:mm:ss.sssZ`, Z suffix, no local offset |
| B-3-20 | `discoveredBy-format-agent-N` | Always `"agent-N"`, N 1-indexed in `[1, agentCount]`, stable per run |

In addition, two existing contracts were extended (not new IDs):
- **B-3-3**: Extended with unexplored/pages URL overlap semantics.
- **PageRecord.depth**: Extended with redirect hop counting rule (inline doc; not a new B-3-N because the contract is co-located with the interface field).

---

## 5. Class-A Recommendations (No Surface Change Required)

| Gap | Recommended Test | Priority |
|---|---|---|
| A-1 Auth drift mid-run | `TEST: auth-drift-mid-run-re-login`, `TEST: auth-drift-kills-agent-on-second` | P2 |
| A-2 urlQueryParamBlacklist | `TEST: url-canonicalization-blacklist-strips-custom-params` | P2 |
| A-3 cc non-zero exit heuristic fallback | `TEST: cc-subprocess-transient-failure-uses-fallback` | P2 |

These tests can be written against the existing surface without further surface changes.

---

## 6. Residual: cc Mocking Pattern (Noted, Not a Surface Gap)

The test doc notes (line 370): "Implementation note: how to mock cc subprocess is an internal
detail; test may need to use process.env or IPC intercept per actual fixture design."

This is correctly classified as an **implementation detail** and not a surface gap. The test
framework needs to know how to intercept the `claude` CLI subprocess; this is a test harness
concern, not a contract concern. The surface correctly excludes "the exact claude CLI flags
passed to the AI subprocess" from its scope.

No surface change required. Test harness should use `process.env.TSPR_CC_BIN` or
similar env-var override (implementation to decide); this is out of scope for this report.

---

## 7. Files Modified Summary

| File | Change |
|---|---|
| `docs/details/03-parallel-ui-agents-public-surface.md` | +5 new B-3-* contracts; extended B-3-3; added `urlQueryParamBlacklist` option; updated `generatedAt` doc; added `domHash` to PageRecord; updated `discoveredBy` doc; added `estimated_cost_usd` to CoverageSummary |
| `docs/details/03-parallel-ui-agents-spec.md` | §8 stopping condition 4 clarified (exploration-only counter); §12 cost table footnotes added; §10.1 JSON example updated with `estimated_cost_usd` and depth comment |
| `docs/details/03-parallel-ui-agents-comparison-report.md` | Created (this file) |

---

## 8. Acceptance Checklist

- [x] Comparison report ≥ 130 lines
- [x] Surface patched with new B-3-* contracts for all real class-B gaps (7 gaps → 5 new B-3-N + 2 extensions)
- [x] Class-C unification: `urlQueryParamBlacklist` added to surface; synthesis-vs-maxCcCalls resolved in both docs
- [x] Class-A gaps documented with test recommendations (no surface change needed)
- [x] No push
