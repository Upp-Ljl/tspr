# Module 04 — Auto-Patch Report: SPEC-SPLIT Comparison Report

> SPEC-SPLIT artifact (step 4 — comparison)
> Inputs: `04-autopatch-report-spec.md` + `04-autopatch-report-public-surface.md` + `04-autopatch-report-tests.md`
> Date: 2026-05-26
> Knight-Leveson discipline: dev-doc author and test-doc author read different inputs;
> this report compares their independent outputs to surface latent contract gaps.

---

## 0. Summary

| Class | Count | Description |
|---|---|---|
| A | 4 | Spec promises behavior that no test covers |
| B | 5 | Test assumes a contract the surface does not expose |
| C | 1 | Spec and surface disagree; must be unified |

**Total gaps: 10**

New B-4-* contracts added to surface: B-4-22 through B-4-26.
Class-C resolution: B-4-9 stays as bytes; B-4-16 step 8 clarified to "2048 JavaScript characters (`string.length`)".
Spec amended at §7 code comment to document the intentional unit divergence.

---

## 1. Class-A Gaps — Spec Promises Not Tested

These behaviors are described in `04-autopatch-report-spec.md` but have no corresponding test in `04-autopatch-report-tests.md`. The surface exposes these behaviors but the test doc never asserts them.

---

### A-1: `dbSnapshot` omitted when JSON > 50 KB

**Source**: Spec §4.7:
> "Cap: if snapshot JSON exceeds 50 KB, it is omitted entirely from the report (treated as if `captureDb` was false), and a warning is logged."

**Surface exposure**: `dbSnapshot?: DbSnapshot` is optional; the surface says it is "optional; only included if db introspection enabled" but does not document the 50 KB drop rule.

**Test coverage**: None. The tests `dbsnapshot-absent-is-valid` and `dbsnapshot-present-is-valid` only check optionality, not the cap enforcement.

**Disposition**: Spec should expose the 50 KB cap as a surface-level contract so tests can assert it. Tracked as a Class-B gap (see B-2 below) because the surface also lacks the contract.

---

### A-2: Binary `request.body` / `response.body` handling

**Source**: Spec §4.6:
> "If body is binary (Content-Type not text/* or application/json), store `[binary body omitted]`."

**Surface exposure**: `HttpRequest.body?: string` — the surface says "≤10 KB; null if no body" but says nothing about binary bodies or the sentinel string `[binary body omitted]`.

**Test coverage**: None. No test exercises binary Content-Type input.

**Disposition**: Minor omission. The sentinel string `[binary body omitted]` is an observable contract. Callers may pattern-match on it for display purposes.

---

### A-3: TestSprite compat file output

**Source**: Spec §9 documents the full TestSprite compat schema mapping triggered by `LOCALSPRITE_EMIT_TESTSPRITE_COMPAT=1`.

**Surface exposure**: Not mentioned in the public surface. §7 ("What Is NOT in This Surface") does not explicitly exclude it either.

**Test coverage**: The test section §11 is titled "MCP Tool Return Shape / TestSprite Compat Tests" but contains only MCP shape tests (`mcp-return-shape`, `mcp-text-not-base64`, `mcp-json-parse-round-trip`). No test touches the compat file, env-var trigger, or schema mapping.

**Disposition**: The compat file is a side-effect of `buildReport`, not a return value, so it arguably belongs in a separate surface section. Low priority for blackbox test coverage; logged as a coverage gap.

---

### A-4: `failureKind` classification input-to-output mapping

**Source**: Spec §3.1 documents a 6-step priority-ordered classification algorithm:
1. `TimeoutError` / `exceeded timeout` → `TIMEOUT`
2. `Error: expect(` / `AssertionError` → `ASSERTION`
3. Network interception: 4xx/5xx/ECONNREFUSED + `page.goto`/`fetch` → `NETWORK`
4. `Navigation` + failed → `NAVIGATION`
5. Screenshot diff present + diff > threshold → `VISUAL`
6. Fallback → `EXCEPTION`

**Surface exposure**: Surface §7 ("What Is NOT in This Surface") explicitly states: "How `FailureKind` classification priority is ordered internally." The enum values are exposed but no test vectors are given.

**Test coverage**: No test asserts a specific `failureKind` value for a specific input. The test doc flagged this as a gap (tests doc §12, GAP: failurekind-classification-source).

**Disposition**: The surface intentionally hides the priority logic, which is correct. However, without at least a few canonical input-to-kind examples, the enum is essentially unassertable from blackbox. Recommend adding a non-exhaustive example table to the surface (see B-4-23 below) — the internal priority ordering can remain hidden while still giving testers assertable anchors.

---

## 2. Class-B Gaps — Tests Assume Contracts the Surface Lacks

The blackbox tester independently identified the following assertions that require contracts not present in the current surface. Each becomes a new B-4-* entry.

---

### B-1 → New contract B-4-22: Body redaction depth (recursive vs. top-level)

**Test**: `redact-nested-json-body`
```
GIVEN: httpRequest.body = '{"auth":{"password":"s3cr3t"},"data":{"name":"test"}}'
THEN: At minimum auth.password === "[REDACTED]"
```

**What test assumes**: Redaction traverses nested JSON objects. `{"auth":{"password":"x"}}` is covered.

**What surface says** (B-4-7): "any JSON value associated with a key matching the pattern is replaced with `[REDACTED]`." — Does not specify whether traversal is top-level only or recursive.

**Spec says** (§6 body redaction regex): The regex `/("password|secret|token|api[_-]?key")\s*:\s*"[^"]+"/gi` is applied to the raw body string — making it effectively recursive by text matching regardless of JSON nesting depth, since string scanning finds keys at any depth.

**Decision**: The regex is applied to the body string (not parsed JSON), so it naturally matches at any nesting depth. This is a real contract: a caller relying on redaction must know that deeply nested secrets are covered. Add contract B-4-22.

---

### B-2 → New contract B-4-23: `failureKind` canonical input examples

**Test**: Multiple tests reference `failureKind` but cannot assert its value.

**What test assumes**: Testers need at least one assertable input → `failureKind` mapping.

**What surface says**: Enum values listed; classification logic excluded from surface (§7).

**Decision**: Add a non-exhaustive example table to the surface. The table does not expose internal priority ordering but provides testers with anchors for happy-path assertions. Classification is still implementation-defined for edge cases.

---

### B-3 → New contract B-4-24: `confidence` normalization formula

**Test**: `patch-absent-at-threshold-boundary`, `confidence-scale-boundary-6-vs-7`

**What test assumes**: `confidence = rawScore / 10` (integer division). Specifically, score 6 → 0.6, score 7 → 0.7.

**What surface says** (B-4-2): "raw integer score < 7 on a 0–10 scale" — implies division by 10 but does not state the formula. Non-integer raw scores are unspecified.

**Spec says** (§4.5): "compute `confidence = N / 10`" where N is the integer from `CONFIDENCE:N`. Non-integer values are not explicitly handled, but `N` is documented as "integer".

**Decision**: The formula is observable (callers can verify the mapping from displayed score to the `confidence` field). Expose as contract B-4-24. Clarify that non-integer raw scores (e.g., `6.5`) are accepted and normalized by the same formula, yielding `0.65`.

---

### B-4 → New contract B-4-25: `testId` cross-platform path normalization

**Test**: `testid-stable-across-runs`, `testid-stable-different-runid`

**What test assumes**: `testId` is stable across platforms (Windows backslash vs. POSIX forward-slash).

**What surface says** (B-4-4): "Given the same `testFile` and `testName`, `testId` is identical across separate `buildReport` calls." — Says nothing about path separator normalization.

**Spec says** (§4.1): Hash input is `testFile + "\x00" + testName` verbatim. If a Windows runner provides `src\tests\login.ts` and a macOS runner provides `src/tests/login.ts`, the hashes will differ — violating the "stable" promise in a cross-platform context.

**Decision**: This is a real contract gap. The surface must state whether `testFile` is normalized before hashing. Add contract B-4-25 specifying forward-slash normalization before hash input. (This also requires the spec to be amended to normalize — see implementation note; the spec as written hashes verbatim, which is a bug for cross-platform use. The comparison report surfaces this; the spec fix is out of scope for this SPEC-SPLIT step but the gap is flagged.)

**Note on spec amendment scope**: The spec §4.1 code uses `testFile + "\x00" + testName` verbatim. Amending the spec implementation is a code-correctness fix, not a contract clarification. The surface B-4-25 contract added here documents the *intended* behavior (normalized). The spec implementation should be updated in a follow-up to match.

---

### B-5 → New contract B-4-26: `REPORT_SERIALIZATION_FAILED` trigger mechanism

**Test**: `error-serialization-failed`

**What test assumes**: A blackbox caller can trigger this error code to verify the `ReportError` shape.

**What surface says** (§4 Error Codes): `REPORT_SERIALIZATION_FAILED` is documented but no input path is exposed that can trigger it from outside.

**Spec says** (§10): "Throw `ReportError("REPORT_SERIALIZATION_FAILED", cause)` — propagated to MCP tool handler." — The cause is a circular reference introduced by a programmer bug; normal inputs never produce this.

**Decision**: The test doc correctly identifies this as untestable from outside. Add contract B-4-26 making the untestability explicit and official: the error code is a programmer-error sentinel that cannot be triggered by well-formed `BuildReportInput`. Blackbox tests should document this as "verified by code review, not by input injection." This is an honest contract statement, not a gap to paper over.

---

## 3. Class-C Gaps — Spec and Surface Disagree

### C-1: `stack` truncation unit in size-cap step 8

**The inconsistency**:

| Location | Stated unit | Quote |
|---|---|---|
| Surface B-4-9 (normal cap) | UTF-8 bytes | "at most 8 × 1024 bytes when encoded as UTF-8" |
| Surface B-4-16 step 8 (size-cap emergency) | Ambiguous "chars" | "stack truncated to 2048 chars" |
| Spec §7 `applySizeCap` code | JS `.length` (UTF-16 code units) | `f.stack.length > 2048` |

**Analysis**:
- B-4-9 (normal truncation during stack cleaning, `src/report/sourceMap.ts`) uses byte measurement, consistent with UTF-8 encoding context.
- B-4-16 step 8 (emergency size-cap truncation, `src/report/sizeCap.ts`) uses `string.length` which is JavaScript UTF-16 code unit count — not byte count.
- These are **two different truncation operations** at different points in the pipeline. The unit difference is therefore intentional: the first is a byte-level cap on the processed stack; the second is a character-count emergency truncation applied to the serialized structure.
- For ASCII-only stack traces (typical in practice), bytes = chars = UTF-16 code units, so the difference is invisible. For multi-byte characters (e.g., Cyrillic/CJK in test names), they diverge.

**Decision: bytes win for B-4-9; JavaScript `.length` characters win for B-4-16 step 8.**

Rationale: These are genuinely different operations with different measurement contexts:
- `sourceMap.ts` works in UTF-8 byte space (it interacts with file buffers and network transport).
- `sizeCap.ts` works in JavaScript string space (it slices JS strings with `.slice()`).

Unifying to the same unit across both would require changing one of the implementations. The spec implementation in `sizeCap.ts` is explicit: `f.stack.length > 2048` and `.slice(0, 2048)` — JS character semantics. The surface should match.

**Surface amendment**: B-4-16 step 8 changed from "2048 chars" to "2048 JavaScript characters (`string.length`; not UTF-8 bytes)".

**Spec amendment**: Add a comment to the `sizeCap.ts` code block in §7 clarifying the intentional unit difference from B-4-9.

---

## 4. Gap Disposition Table

| Gap slug | Class | New contract | Resolution |
|---|---|---|---|
| `failurekind-classification-source` | A | B-4-23 | Surface gains non-exhaustive example table |
| `binary-body-sentinel` | A | — | Logged; low priority; implementation detail |
| `testsprite-compat-untested` | A | — | Logged; compat is a side-effect, separate surface needed |
| `dbsnapshot-50kb-cap` | A+B | — | Spec-level; surface intentionally omits implementation cap triggers |
| `body-redaction-nesting-depth` | B | B-4-22 | Recursive by regex; contract made explicit |
| `failurekind-classification-source` | B | B-4-23 | Non-exhaustive example table added |
| `confidence-raw-scale-mapping` | B | B-4-24 | Formula `rawScore / 10` made explicit; non-integer accepted |
| `testid-hash-input-normalization` | B | B-4-25 | Forward-slash normalization before hash input; spec needs code fix |
| `serialization-error-injection` | B | B-4-26 | Error declared untriggerable from external input; test notes updated |
| `stack-truncation-unit-inconsistency` | C | — | B-4-16 step 8 clarified to JS chars; B-4-9 stays bytes; spec comment added |

---

## 5. Deferred Items

| Slug | Why deferred |
|---|---|
| `binary-body-sentinel` | Observable string `[binary body omitted]` is low-value for blackbox assertion; the Content-Type detection is an implementation mechanism. Exposing the sentinel is useful for UI display but does not affect correctness of the core contract. |
| `testsprite-compat-untested` | TestSprite compat is a file side-effect with its own surface (env-var trigger + separate JSON schema). It belongs in a dedicated SPEC-SPLIT artifact for the compat module, not in the core report surface. |
| `dbsnapshot-50kb-cap` | The 50 KB cap on `dbSnapshot` is an implementation detail of the backend data-capture path. The observable contract from outside is just "dbSnapshot may be absent" — which is already captured by the optional field. Exposing the exact byte threshold would over-specify. |
| `testid-cross-platform-spec-fix` | B-4-25 defines the intended contract (forward-slash normalization). The spec §4.1 code needs a corresponding implementation amendment, but that is a code change, not a contract clarification. Filed as a follow-up code fix; out of scope for this SPEC-SPLIT comparison step. |

---

## 6. Verification Checklist

- [x] All 6 blackbox-reported gaps classified (B-1 through B-5 + C-1)
- [x] Additional A-gaps found via independent spec audit (A-1 through A-4)
- [x] New contracts B-4-22 through B-4-26 added to `04-autopatch-report-public-surface.md`
- [x] Class-C inconsistency resolved: B-4-16 step 8 amended to "2048 JavaScript characters"
- [x] Spec §7 comment added to document intentional unit divergence
- [x] No spec implementation code changed (surface clarification only for C-1)
- [x] Coverage Map in test doc implicitly extended (new B-4-* contracts not yet covered; to be added by test author in next pass)

---

*End of comparison report.*
