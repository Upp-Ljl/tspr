# SPEC-SPLIT Comparison Report — Docker Ephemeral Sandbox (02)

> SPEC-SPLIT artifact · Layer: comparison-report
> Date: 2026-05-26
> Sources:
>   - Dev spec:    `docs/details/02-docker-sandbox-spec.md` (572 lines)
>   - Public surface: `docs/details/02-docker-sandbox-public-surface.md` (334 lines)
>   - Blackbox tests: `docs/details/02-docker-sandbox-tests.md` (1073 lines, test-docker worktree)

---

## 1. Summary Table

| Class | Count | Description |
|---|---|---|
| A | 3 | Spec promises X; tests don't cover X — logged only, no surface patch |
| B | 7 | Tests assume X; surface lacks explicit contract — **surface patched** |
| C | 1 | Spec / surface / tests disagree — **spec or surface unified** |
| **Total** | **11** | |

### Top 5 by Priority

| Rank | Slug | Class | Impact |
|---|---|---|---|
| 1 | `PORT-FORWARDING-CONTRACT` | B+C | Test uses `handle.port` as both host and container port — surface is ambiguous AND surface proposed fix was wrong (projectType-based mapping); spec uses same port on both sides |
| 2 | `MAX-CONCURRENT-ERROR-CODE` | B | Test asserts `SandboxError` with unknown code; callers cannot distinguish this from other errors |
| 3 | `PULL-ARTIFACTS-MISSING-FILE-CONTRACT` | B | Test probes silent-success on empty artifacts; surface is silent on this path |
| 4 | `SIGTERM-CLEANUP` | B | Spec §7 registers SIGTERM; surface B-2-16 only names SIGINT — test coverage gap |
| 5 | `OOM-TRIGGER-CONTRACT` | B | Surface says "subsequent exec() calls MUST throw" but "subsequent" timing is ambiguous — test cannot reliably assert timing |

---

## 2. Per-Gap Entries

---

### GAP-01 — PULL-ARTIFACTS-MISSING-FILE-CONTRACT

**Class**: B
**Flagged by**: Blackbox tester (§6, gap 1) and test `PULL-ARTIFACTS-MISSING-FILE`
**Where in surface**: B-2-17 — contains parenthetical "(if it exists)" but provides no explicit
  contract for the case where `/tmp/localsprite-out/` does not exist or is empty.
**Where in spec**: §6.2 describes the `getArchive` mechanism; §9 notes `ERR_ARTIFACT_PULL_FAILED`
  is thrown when `getArchive()` throws — but does not distinguish between "path not found"
  (expected empty-output case) and "container stopped" (real failure).
**Root cause**: The spec author conflated two distinct failure modes for `getArchive`:
  1. Container is alive but the output directory is empty/absent → should succeed silently
  2. Container is stopped or archive stream errors → should throw `ERR_ARTIFACT_PULL_FAILED`
  The surface inherits this ambiguity via the parenthetical.
**Resolution**: Add B-2-25 to surface: `pullArtifacts()` MUST resolve without throwing if
  `/tmp/localsprite-out/` does not exist in the container or is empty. No host-side files
  are created for absent source files.
**Resolution ref**: New contract B-2-25 (added below in §4).

---

### GAP-02 — MAX-CONCURRENT-ERROR-CODE

**Class**: B
**Flagged by**: Blackbox tester (§6, gap 2) and test `MAX-CONCURRENT-EXCEEDED`
**Where in surface**: §6 config table lists `LOCALSPRITE_SANDBOX_MAX_CONCURRENT = 3` as an
  observable env var. §4 error table has no entry for concurrency limit exceeded. The test
  can only assert `instanceof SandboxError` but not the code.
**Where in spec**: §8 Concurrency Model mentions the `activeContainers Set` and port collision
  prevention, but no explicit error path for max-concurrent reached is spec'd.
**Root cause**: The config knob was exposed in the surface without completing the error path
  contract — an observer can set the knob but cannot know which code to catch.
**Resolution**: Add `ERR_MAX_CONCURRENT_EXCEEDED` to §4 error table and add B-2-26 contract.
**Resolution ref**: New contract B-2-26 and error table row (added below in §4).

---

### GAP-03 — PORT-FORWARDING-CONTRACT

**Class**: B (partially C — blackbox tester's proposed resolution was incorrect)
**Flagged by**: Blackbox tester (§6, gap 3) and test `BOOTAPP-HTTP-PROBE`
**Where in surface**: §2.2 SandboxHandle says `handle.port` is "Allocated host TCP port forwarded
  into the container" — does not say which container-side port it maps to. Test
  `BOOTAPP-HTTP-PROBE` assumes the container's port 3000 maps to `handle.port`.
**Where in spec**: §4.2 Docker container create spec is explicit:
  ```
  ExposedPorts: one ephemeral port from range [32768, 60999]
  PortBindings: host 0.0.0.0:<allocatedPort> → container <allocatedPort>
  ```
  The same ephemeral number is used on BOTH sides. There is no projectType-based port mapping.
**Root cause**: Blackbox tester's proposed fix ("projectType default port mapping: 3000 for
  frontend, 4000 for backend") was invented — the spec defines a single ephemeral port
  used symmetrically. Tests that pass container port 3000 to `bootApp` opts need to bind
  their server on the correct container port, not assume `handle.port` is 3000.
**Class C element**: Test `BOOTAPP-HTTP-PROBE` fixture comment "container's port 3000 is mapped
  to `handle.port`" is wrong — it would only be true if the server binds to `handle.port`
  inside the container. This is a test-doc error but requires surface clarification.
**Resolution**: Add B-2-27 to surface: `handle.port` is the same integer on both the host
  and the container side. The container exposes exactly one port equal to `handle.port`.
  Apps running inside the container MUST bind to `handle.port` to be reachable.
**Spec patch**: None needed (spec §4.2 is already correct).
**Test doc note**: Test `BOOTAPP-HTTP-PROBE` is misleading but test-doc is not patched here
  (out of scope for spec-docker worktree). Flag for test-docker worktree to correct.
**Resolution ref**: New contract B-2-27.

---

### GAP-04 — SIGTERM-CLEANUP

**Class**: B
**Flagged by**: Blackbox tester (§6, gap 4 — implicit) and surface analysis
**Where in surface**: B-2-16 names only SIGINT. SIGTERM is not mentioned.
**Where in spec**: §7 registry.ts explicitly registers BOTH `process.on('SIGINT', ...)` AND
  `process.on('SIGTERM', ...)` — the cleanup function is identical.
**Root cause**: Surface author wrote B-2-16 based on user-observable signal (Ctrl+C = SIGINT)
  and forgot to include SIGTERM which is the canonical process-manager termination signal.
**Resolution**: Add B-2-28 to surface mirroring B-2-16 for SIGTERM.
**Resolution ref**: New contract B-2-28.

---

### GAP-05 — DISPOSE-STATUS-DURING-STOPPING

**Class**: B
**Flagged by**: Blackbox tester (§6, gap 5)
**Where in surface**: The `SandboxHandle.status` type includes `'stopping'` as a valid value,
  but no B-2-* contract says when it is observable or whether callers should act on it.
**Where in spec**: §4.1 state machine shows STOPPING as a transient state between RUNNING and
  REMOVING. The spec does not say whether external callers observe it.
**Root cause**: A type value was included in the public API signature without a corresponding
  behavioral contract. Callers reading only the surface cannot know if they should poll
  for `'stopping'` or only for `'disposed'`.
**Resolution**: Add B-2-29: during `dispose()` (after call, before resolution) `handle.status`
  MAY equal `'stopping'`; once `dispose()` resolves, status MUST equal `'disposed'`.
  Callers MUST NOT rely on observing `'stopping'` (it is transient and may be skipped).
**Resolution ref**: New contract B-2-29.

---

### GAP-06 — OOM-TRIGGER-TIMING-CONTRACT

**Class**: B
**Flagged by**: Blackbox tester (§6, gap 6 — OOM-TRIGGER-CONTRACT) and test `OOM-DETECTION`
**Where in surface**: B-2-21 says "subsequent `exec()` calls MUST throw `SandboxError` with
  `code === 'ERR_OUT_OF_MEMORY'`" — "subsequent" is ambiguous about timing: Does the
  FIRST exec after OOM kill throw? Is there a race if exec is in-flight when OOM fires?
**Where in spec**: §9 error table: `ERR_OUT_OF_MEMORY` when "exit code 137". The spec does
  not describe whether OOM detection is poll-based or event-based.
**Root cause**: B-2-21 was written at the result level (what is thrown) without specifying
  the trigger point (when detection occurs). Test `OOM-DETECTION` must know whether to
  call exec immediately or wait.
**Resolution**: Add B-2-30 clarifying that OOM detection occurs eagerly: after any `exec()`
  completes with exit code 137 AND container inspect confirms `OOMKilled = true`, ALL
  subsequent `exec()` calls on that handle MUST throw `ERR_OUT_OF_MEMORY`. The OOM state
  is sticky — once detected, it persists until `dispose()`.
  Caveat: detection requires a completed exec (not just container death); a fresh exec
  call immediately after OOM kill MAY fail with a different error if the container is
  mid-removal. This is NOT a contract violation.
**Resolution ref**: New contract B-2-30 (amends B-2-21).

---

### GAP-07 — IMAGE-BUILD-FAILED-CLEAN-STATE

**Class**: B
**Flagged by**: Blackbox tester (§6 ERR-IMAGE-BUILD-FAILED test note) and analysis
**Where in surface**: B-2-2 guarantees clean state for `ERR_DOCKER_UNAVAILABLE` only. No
  equivalent guarantee exists for `ERR_IMAGE_BUILD_FAILED`.
**Where in spec**: §3 pre-flight sequence shows image build/pull happens before container
  creation. If build fails, the container creation step is never reached — clean by
  construction. But this is an implementation detail, not an observable contract.
**Root cause**: B-2-2 was narrowly written for the pre-flight case without being generalized
  to all pre-container-creation failures.
**Resolution**: Add B-2-31: when `ERR_IMAGE_BUILD_FAILED` is thrown, no container with label
  `localsprite.managed = "true"` may exist as a result of that call.
**Resolution ref**: New contract B-2-31.

---

### GAP-08 — PORT-RANGE-INCONSISTENCY (Class C)

**Class**: C — spec, surface, and test disagree on port range
**Flagged by**: This comparison (not flagged by blackbox tester)
**Where in spec**: §4.2 allocates from `[32768, 60999]`; §8 confirms `allocatedPorts Set` in
  this range.
**Where in surface**: B-2-3 says `handle.port` is in `[1, 65535]` — an extremely broad range
  that includes reserved ports.
**Where in tests**: CI assumption §1.2 says "Ephemeral TCP ports in the range [1024, 65535]
  are allocatable." Test `CREATE-SUCCESS-FIELDS` asserts `handle.port >= 1`.
**Root cause**: Surface author wrote the widest safe type assertion (`[1, 65535]`) rather than
  the actual allocated range. Callers who need to open firewall rules or debug connectivity
  cannot predict the port range.
**Resolution**: Patch surface B-2-3 to narrow the range to `[1024, 65535]` (a tighter but
  still implementation-agnostic contract that excludes reserved ports <1024 while not
  pinning to the exact internal [32768, 60999] range which is an implementation detail).
  Spec §4.2 range [32768, 60999] is narrower than this and always satisfies it.
**Resolution ref**: Patch to B-2-3 in surface (see §3 below).

---

### GAP-09 — DISPOSE-PULLS-ARTIFACTS-CONTRACT (Class A)

**Class**: A — spec promises, tests don't cover
**Where in spec**: §6.2: "`pullArtifacts()` is called by `dispose()` automatically before
  container removal." §5 Lifecycle Invariant 4 repeats this.
**Where in surface**: B-2-17 and B-2-18 cover explicit `pullArtifacts()` calls; no contract
  states that `dispose()` automatically calls `pullArtifacts()`.
**Where in tests**: No test verifies that artifacts land in `runDir` WITHOUT an explicit
  `pullArtifacts()` call, relying only on `dispose()`.
**Root cause**: The automatic-pull behavior was spec'd as an implementation detail and not
  lifted to a surface contract. A test of the full flow (`exec` → `dispose()` → check
  `runDir`) would catch this.
**Resolution (A = log only)**: Document as deferred. Recommend adding a surface contract in a
  future revision if callers need to rely on implicit pull in `dispose()`.

---

### GAP-10 — EXEC-DEFAULT-CWD-CONTRACT (Class A)

**Class**: A — spec promises, tests cover it implicitly but no dedicated B-2-* contract
**Where in spec**: §5.1 `ExecOptions.cwd` — "default /work".
**Where in surface**: §2.3 ExecOptions type comment says "working dir inside container; default
  /work" — but this is in the type table, not a B-2-* behavioral contract.
**Where in tests**: Test `EXEC-DEFAULT-CWD-IS-WORK` covers this (asserts `pwd` returns `/work`
  when no `cwd` option passed), but maps it to B-2-4 and "ExecOptions.cwd default" — not
  a dedicated B-2-* number.
**Root cause**: Default cwd for exec is observable behavior but treated as a type annotation
  rather than a named contract. If implementation changes the default, tests would catch
  it but the surface contract doesn't formally govern it.
**Resolution (A = log only)**: Low severity — type annotation is testable. Recommend
  promoting to a named B-2-* contract in future revision for completeness.

---

### GAP-11 — BEFOREEXIT-CLEANUP-NOT-IN-SURFACE (Class A)

**Class**: A — spec promises, tests don't cover
**Where in spec**: §7 registry.ts registers `process.on('beforeExit', ...)` in addition to
  SIGINT/SIGTERM. This handles graceful exit when the event loop drains naturally.
**Where in surface**: B-2-16 covers SIGINT only (class B gap for SIGTERM is patched above).
  `beforeExit` is mentioned in neither.
**Where in tests**: No test for `beforeExit` cleanup. The test for SIGINT (a separate
  subprocess test) would not catch the `beforeExit` path.
**Root cause**: `beforeExit` is a Node.js-internal event rarely visible to callers;
  documenting it as an observable contract is a judgment call. The blackbox tester
  did not identify it.
**Resolution (A = log only)**: Defer. `beforeExit` cleanup is an implementation defense
  against leaked containers; it is not a caller-observable contract. If tests are added,
  they would exercise normal process exit (not signal-based), which is hard to isolate.

---

## 3. Patches Applied

### 3.1 Surface — B-2-3 port range narrowed (Class C)

**File**: `docs/details/02-docker-sandbox-public-surface.md`
**Old text (B-2-3)**:
> `handle.port` MUST be a positive integer in the range [1, 65535].

**New text**:
> `handle.port` MUST be a positive integer in the range [1024, 65535].
> (Ports below 1024 are reserved; the module MUST NOT allocate them.)

**Why**: Original range [1, 65535] includes privileged ports (1–1023) which the module
never uses. Narrowing to [1024, 65535] is a tighter, still implementation-agnostic
contract consistent with spec §4.2 (which uses [32768, 60999] ⊂ [1024, 65535]) and
with the test CI assumption in §1.2.

---

### 3.2 Surface — New B-2-25 through B-2-31 added (Class B)

**File**: `docs/details/02-docker-sandbox-public-surface.md`
New contracts appended after B-2-24. See §4 below.

---

## 4. New Contracts (B-2-25 through B-2-31)

These are reproduced here for reference; the authoritative text is in the patched
`02-docker-sandbox-public-surface.md` §3.

### B-2-25 pullArtifacts — silent success on absent output directory
If `/tmp/localsprite-out/` does not exist inside the container, or the directory is
empty, `pullArtifacts()` MUST resolve without throwing. No host-side files are created
for absent source paths. Callers MUST NOT assume that a non-throwing return from
`pullArtifacts()` implies any file was written.

### B-2-26 concurrent sandboxes — max concurrent limit error code
When `createSandbox()` is called and the number of active sandboxes already equals
`LOCALSPRITE_SANDBOX_MAX_CONCURRENT` (default 3), the call MUST throw `SandboxError`
with `code === 'ERR_MAX_CONCURRENT_EXCEEDED'`. The error MUST be thrown before any
container is created.

### B-2-27 handle.port — same port on host and container sides
`handle.port` is the port number used on BOTH the host and the container side of the
port binding. Applications running inside the container MUST bind to `handle.port`
(not to a fixed port such as 3000 or 4000) to be reachable from the host via
`localhost:handle.port`. There is no projectType-based default port mapping.

### B-2-28 SIGTERM cleanup
If the host Node process receives SIGTERM while one or more sandboxes are in `'running'`
state, all running containers MUST be disposed (force-killed and removed) before the
process exits. Behavior is equivalent to SIGINT (B-2-16). No `localsprite.managed = "true"`
containers may be left running after the process terminates.

### B-2-29 dispose — 'stopping' state is transient and may be skipped
After `dispose()` is called and before it resolves, `handle.status` MAY equal `'stopping'`.
Once `dispose()` resolves, `handle.status` MUST equal `'disposed'` (B-2-13 is unaffected).
Callers MUST NOT rely on observing the `'stopping'` state — it is an internal transient
state and implementations MAY transition directly from `'running'` to `'disposed'`
synchronously after the container is removed.

### B-2-30 OOM detection — sticky after confirmed OOM kill
After any `exec()` call completes on a container that has been OOM-killed (Docker reports
exit code 137 AND `OOMKilled = true` in container inspect), the handle enters OOM state.
All subsequent `exec()` calls on that handle MUST throw `SandboxError` with
`code === 'ERR_OUT_OF_MEMORY'`. The OOM state is sticky: once set, it persists until
`dispose()` is called. Note: if an `exec()` call is in-flight at the moment of OOM kill,
that call MAY fail with a different error — only the next exec after a completed exec
confirms OOM state. This is NOT a contract violation.

### B-2-31 image build failure — no container leak
When `ERR_IMAGE_BUILD_FAILED` is thrown, no container with label
`localsprite.managed = "true"` may exist as a result of that call.
(Parallel guarantee to B-2-2 for the image-build failure path.)

---

## 5. Deferred Punch List

| Slug | Class | Why deferred |
|---|---|---|
| `DISPOSE-PULLS-ARTIFACTS-CONTRACT` | A | Auto-pull in dispose() is impl detail; making it a contract would constrain the impl unnecessarily. Revisit if callers need to rely on it. |
| `EXEC-DEFAULT-CWD-CONTRACT` | A | Already covered by type annotation in surface §2.3; low severity. Promote to B-2-* if a test regression occurs. |
| `BEFOREEXIT-CLEANUP-NOT-IN-SURFACE` | A | `beforeExit` is a defensive impl measure, not caller-observable. Documenting it as a contract is over-specification. |
| `BOOTAPP-HTTP-PROBE-FIXTURE-ERROR` | C (test-doc) | Test `BOOTAPP-HTTP-PROBE` comment says "container port 3000 is mapped to `handle.port`" — this is wrong (B-2-27 clarifies). Correction needed in test-doc worktree, out of scope here. |

---

## 6. Verdict

All 7 blackbox-reported gaps assessed. 6 patched (B-2-25 through B-2-31, including one
disagreement with proposed resolution for GAP-03 PORT-FORWARDING-CONTRACT). 1 agreed as
deferred (IMAGE-BUILD-FAILED became B-2-31, so actually all 7 are patched). 1 additional
Class C gap found (PORT-RANGE-INCONSISTENCY, patched in B-2-3). 3 Class A gaps logged
and deferred.

Surface is now complete enough for the blackbox tester to write all test cases without
ambiguity.
