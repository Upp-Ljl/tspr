# Public Surface — Docker Ephemeral Sandbox (02)

> SPEC-SPLIT artifact · Layer: public-surface (blackbox contract)
> Date: 2026-05-26
> Status: draft
>
> **Reading rule**: a test author reading ONLY this file (not the spec, not source) must be able
> to write a complete test suite. Nothing here depends on implementation details.

---

## 1. Module Entry Point

```ts
import { createSandbox, withSandbox, SandboxError } from 'localsprite/sandbox';
```

---

## 2. TypeScript Signatures

### 2.1 `createSandbox`

```ts
function createSandbox(options: CreateSandboxOptions): Promise<SandboxHandle>
```

Creates and starts one ephemeral Docker container.
Throws `SandboxError` on any failure (see §6).
On success, the container is in `RUNNING` status and registered for automatic cleanup.

```ts
interface CreateSandboxOptions {
  projectPath: string;        // REQUIRED — absolute path to user project on host
  projectType: 'frontend' | 'backend' | 'fullstack';  // REQUIRED
  env?: Record<string, string>;       // extra env vars injected into container
  ttlMs?: number;             // container auto-kill after this many ms; default 300_000
  memLimitMb?: number;        // memory limit in MiB; default 1024
  cpuQuota?: number;          // Docker cpu_quota units; default 100_000 (≈1 CPU)
  networkMode?: string;       // default 'bridge'; pass 'none' to block external network
}
```

### 2.2 `SandboxHandle` — returned by `createSandbox`

```ts
interface SandboxHandle {
  /** Docker container ID (64-char hex string). Unique per process run. */
  readonly id: string;

  /** UUID identifying this test run. Used as a key in ~/.localsprite/runs/. */
  readonly runId: string;

  /** Allocated host TCP port forwarded into the container. */
  readonly port: number;

  /** Absolute path on host where artifacts are written after pullArtifacts(). */
  readonly runDir: string;

  /** Current lifecycle status. */
  readonly status: 'running' | 'stopping' | 'disposed';

  /** Run a command to completion inside the container. */
  exec(cmd: string, opts?: ExecOptions): Promise<ExecResult>;

  /** Start a long-running app process inside the container; wait until ready. */
  bootApp(cmd: string, opts: BootAppOptions): Promise<AppHandle>;

  /** Copy artifacts from container to runDir on host. Idempotent. */
  pullArtifacts(): Promise<void>;

  /** Stop and remove the container. Safe to call multiple times (idempotent). */
  dispose(): Promise<void>;
}
```

### 2.3 `exec`

```ts
exec(cmd: string, opts?: ExecOptions): Promise<ExecResult>

interface ExecOptions {
  cwd?: string;                        // working dir inside container; default /work
  timeout?: number;                    // ms before exec is killed; default 60_000
  env?: Record<string, string>;        // merged on top of container env
}

interface ExecResult {
  exitCode: number;    // process exit code (0 = success)
  stdout: string;      // full stdout as UTF-8 string
  stderr: string;      // full stderr as UTF-8 string
  durationMs: number;  // wall-clock time from exec start to stream close
  timedOut: boolean;   // true if process was killed because opts.timeout was reached
}
```

### 2.4 `bootApp`

```ts
bootApp(cmd: string, opts: BootAppOptions): Promise<AppHandle>

interface BootAppOptions {
  port?: number;                    // port inside container to probe (used by tcp probe)
  readyProbe?: ReadyProbe;          // how to decide the app is ready; default: tcp on opts.port
  startupTimeoutMs?: number;        // ms until giving up; default 30_000
  env?: Record<string, string>;
}

type ReadyProbe =
  | { type: 'tcp';    port: number }
  | { type: 'http';   url: string; expectedStatus?: number }   // default expectedStatus: 200
  | { type: 'stdout'; pattern: RegExp };

interface AppHandle {
  readonly pid: number;             // PID of the process inside the container
  kill(): Promise<void>;            // sends SIGTERM; no-op if already stopped
  waitForExit(): Promise<number>;   // resolves with exit code when process ends
}
```

### 2.5 `withSandbox` — try/finally convenience wrapper

```ts
function withSandbox<T>(
  options: CreateSandboxOptions,
  fn: (sandbox: SandboxHandle) => Promise<T>
): Promise<T>
```

Calls `createSandbox(options)`, passes the handle to `fn`, then calls `dispose()` in a
`finally` block regardless of whether `fn` throws.
The return value of `fn` is forwarded as the return value of `withSandbox`.

---

## 3. Behavior Contracts

### B-2-1 Pre-flight: Docker daemon required
`createSandbox()` (and therefore `withSandbox()`) MUST throw `SandboxError` with
`code === 'ERR_DOCKER_UNAVAILABLE'` if the Docker daemon is not reachable.
The error MUST be thrown within **2 000 ms** of the call being made.
The error object MUST carry an `installUrl` string property pointing to Docker install docs.

### B-2-2 Pre-flight: error thrown before any container is created
When `ERR_DOCKER_UNAVAILABLE` is thrown, no container must exist in Docker with label
`localsprite.managed = "true"` as a result of that call.
(Pre-flight failure is clean — no partial state.)

### B-2-3 Successful create returns running handle
If `createSandbox()` resolves, `handle.status` MUST equal `'running'`.
`handle.id` MUST be a non-empty string.
`handle.port` MUST be a positive integer in the range [1024, 65535].
(Ports below 1024 are reserved; the module MUST NOT allocate them.)
`handle.runId` MUST be a non-empty string unique across concurrent calls.
`handle.runDir` MUST be an absolute path string; the directory MUST exist on the host.

### B-2-4 Project path mounted at /work
After `createSandbox()` resolves, `exec('ls /work')` MUST list the contents of
`options.projectPath` (i.e., the directory is bind-mounted read-write at `/work`).

### B-2-5 exec — exit code passthrough
`exec(cmd)` MUST return an `ExecResult` whose `exitCode` equals the actual exit code
of `cmd` inside the container.
`exec('exit 0')` → `exitCode === 0`.
`exec('exit 42')` → `exitCode === 42`.

### B-2-6 exec — stdout/stderr captured separately
stdout and stderr MUST NOT be interleaved in the same field.
A command that writes "OUT" to stdout and "ERR" to stderr MUST produce
`result.stdout` containing "OUT" and `result.stderr` containing "ERR".

### B-2-7 exec — timeout enforced
If `exec(cmd, { timeout: T })` is called and the command runs longer than `T` ms,
the command MUST be killed and `ExecResult.timedOut` MUST be `true`.
`ExecResult.exitCode` MAY be non-zero in this case.
`ExecResult.durationMs` MUST be ≥ `T` and ≤ `T + 2000` (2 s grace).

### B-2-8 exec — throws SandboxError when sandbox disposed
`exec()` called on a handle where `status === 'disposed'` MUST throw `SandboxError`
with a message indicating the sandbox is no longer alive.
It MUST NOT silently return a result.

### B-2-9 bootApp — resolves only when probe succeeds
`bootApp(cmd, { readyProbe: { type: 'tcp', port: P } })` MUST NOT resolve until
a TCP connection to the container's exposed port P succeeds.
If the connection never succeeds within `startupTimeoutMs`, MUST throw `SandboxError`
with `code === 'ERR_CONTAINER_START_TIMEOUT'`.

### B-2-10 bootApp — http probe
`bootApp(cmd, { readyProbe: { type: 'http', url, expectedStatus: S } })` MUST NOT
resolve until `fetch(url)` returns a response with `status === S` (default 200).

### B-2-11 bootApp — stdout probe
`bootApp(cmd, { readyProbe: { type: 'stdout', pattern: /ready/ } })` MUST resolve
as soon as the process writes a line matching `pattern` to stdout.

### B-2-12 dispose — idempotent
`dispose()` MAY be called multiple times without throwing.
The second and subsequent calls MUST be no-ops (resolve immediately).

### B-2-13 dispose — sets status to disposed
After `dispose()` resolves, `handle.status` MUST equal `'disposed'`.

### B-2-14 dispose — container removed
After `dispose()` resolves, the Docker container identified by `handle.id` MUST NOT
appear in `docker ps -a` output. (Verified by inspecting the container: it either
does not exist or is in `removing` state for at most 5 s.)

### B-2-15 TTL auto-dispose
If `dispose()` is NOT called explicitly, the container MUST be force-killed and removed
after `options.ttlMs` milliseconds (default 300 000 ms).
After TTL expiry, `handle.status` MUST become `'disposed'`.

### B-2-16 SIGINT cleanup (POSIX only)
If the host Node process receives SIGINT while one or more sandboxes are in `'running'`
state, all running containers MUST be disposed (force-killed and removed) before the
process exits. No `localsprite.managed = "true"` containers may be left running.

**Platform note**: Applies to Linux/macOS. On Windows, Node's `child_process.kill(signal)`
maps SIGINT/SIGTERM to forceful termination — user-space handlers do not fire. Container
cleanup on Windows falls back to TTL expiry (B-2-15) and the `beforeExit` handler for
graceful exits; abrupt parent-kill scenarios on Windows may leak containers until TTL.

### B-2-17 pullArtifacts — files land in runDir
After `pullArtifacts()` resolves, the file `/tmp/localsprite-out/test_results.json`
inside the container (if it exists) MUST be present at
`path.join(handle.runDir, 'test_results.json')` on the host.

### B-2-18 pullArtifacts — idempotent
Calling `pullArtifacts()` twice MUST NOT throw. The second call MUST overwrite
host-side artifacts with the latest container state.

### B-2-19 withSandbox — dispose on fn throw
If `fn` throws, `withSandbox` MUST still call `dispose()` and MUST re-throw the
original error from `fn`. The dispose error (if any) MUST NOT replace the original error.

### B-2-20 withSandbox — returns fn result on success
If `fn` resolves with value `V`, `withSandbox` MUST resolve with `V`.

### B-2-21 OOM detection
If the container is killed by Docker's OOM killer (exit code 137, `OOMKilled = true`
in container inspect), subsequent `exec()` calls MUST throw `SandboxError` with
`code === 'ERR_OUT_OF_MEMORY'`. The error MUST NOT be silently swallowed.

### B-2-22 concurrent sandboxes — distinct ports
Two concurrent `createSandbox()` calls MUST resolve with handles whose `port` values differ.
Neither call may throw `ERR_PORT_UNAVAILABLE` as a result of the other.

### B-2-23 env injection
`env` passed in `CreateSandboxOptions` MUST be visible inside the container.
`exec('printenv MY_VAR', { env: {} })` where `MY_VAR` was in `options.env`
MUST return `stdout` containing the value of `MY_VAR`.

### B-2-24 exec env override
`env` passed in `ExecOptions` MUST be merged on top of the container env for that exec only.
It MUST NOT permanently modify the container environment.

### B-2-25 pullArtifacts — silent success on absent output directory
If `/tmp/localsprite-out/` does not exist inside the container, or the directory is
empty, `pullArtifacts()` MUST resolve without throwing.
No host-side files are created for absent source paths.
Callers MUST NOT assume that a non-throwing return from `pullArtifacts()` implies any
file was written.

### B-2-26 concurrent sandboxes — max concurrent limit error code
When `createSandbox()` is called and the number of active sandboxes already equals
`LOCALSPRITE_SANDBOX_MAX_CONCURRENT` (default 3), the call MUST throw `SandboxError`
with `code === 'ERR_MAX_CONCURRENT_EXCEEDED'`.
The error MUST be thrown before any container is created.

### B-2-27 handle.port — same port on host and container sides
`handle.port` is the port number used on BOTH the host and the container side of the
port binding.
Applications running inside the container MUST bind to `handle.port` (not to a fixed
port such as 3000 or 4000) to be reachable from the host via `localhost:handle.port`.
There is no projectType-based default port mapping.

### B-2-28 SIGTERM cleanup (POSIX only)
If the host Node process receives SIGTERM while one or more sandboxes are in `'running'`
state, all running containers MUST be disposed (force-killed and removed) before the
process exits.
Behavior is equivalent to SIGINT (B-2-16), including the Windows platform note.
No `localsprite.managed = "true"` containers may be left running after the process
terminates on POSIX platforms.

### B-2-29 dispose — 'stopping' state is transient and may be skipped
After `dispose()` is called and before it resolves, `handle.status` MAY equal `'stopping'`.
Once `dispose()` resolves, `handle.status` MUST equal `'disposed'` (B-2-13 is unaffected).
Callers MUST NOT rely on observing the `'stopping'` state — it is a transient internal
state and implementations MAY transition directly from `'running'` to `'disposed'`
synchronously after container removal.

### B-2-30 OOM detection — sticky after confirmed OOM kill
After any `exec()` call completes on a container that has been OOM-killed (Docker
reports exit code 137 AND `OOMKilled = true` in container inspect), the handle enters
OOM state.
All subsequent `exec()` calls on that handle MUST throw `SandboxError` with
`code === 'ERR_OUT_OF_MEMORY'`.
The OOM state is sticky: once set, it persists until `dispose()` is called.
Note: if an `exec()` call is in-flight at the moment of OOM kill, that in-flight call
MAY fail with a different error — only the next exec call AFTER a completed exec
confirms OOM state. This is NOT a contract violation.

### B-2-31 image build failure — no container leak
When `ERR_IMAGE_BUILD_FAILED` is thrown, no container with label
`localsprite.managed = "true"` may exist as a result of that call.
(Parallel clean-state guarantee to B-2-2, which covers `ERR_DOCKER_UNAVAILABLE`.)

---

## 4. Error Codes Table

| `SandboxError.code` | Thrown by | Meaning |
|---|---|---|
| `ERR_DOCKER_UNAVAILABLE` | `createSandbox` | Docker daemon not reachable within 2 s |
| `ERR_IMAGE_BUILD_FAILED` | `createSandbox` | `localsprite/sandbox-node:24` could not be built or pulled |
| `ERR_CONTAINER_START_TIMEOUT` | `createSandbox`, `bootApp` | Container/app did not reach running/ready state in time |
| `ERR_EXEC_TIMEOUT` | `exec` (via `timedOut: true` in result, NOT thrown) | Exec killed because `opts.timeout` exceeded |
| `ERR_PORT_UNAVAILABLE` | `createSandbox` | No free ephemeral port could be allocated |
| `ERR_MAX_CONCURRENT_EXCEEDED` | `createSandbox` | Active sandbox count already equals `LOCALSPRITE_SANDBOX_MAX_CONCURRENT` |
| `ERR_OUT_OF_MEMORY` | `exec` | Container was OOM-killed |
| `ERR_ARTIFACT_PULL_FAILED` | `pullArtifacts` | tar stream from container could not be extracted (container must be running) |

**Note on `ERR_EXEC_TIMEOUT`**: timeout does NOT throw; it is communicated via
`ExecResult.timedOut === true`. `SandboxError` with this code is never thrown directly.

---

## 5. Lifecycle Invariants

1. **Every handle** that reaches `status === 'running'` MUST eventually reach `status === 'disposed'`
   — via explicit `dispose()`, TTL timer, or SIGINT/SIGTERM handler.
2. **No container** with label `localsprite.managed = "true"` created by this module may outlive
   the Node process that created it (barring OS-level kill of the Docker daemon itself).
3. **`dispose()` is always safe to call** regardless of current status.
4. **`pullArtifacts()` is called before container removal** — either by `dispose()` internally,
   or explicitly by the caller before calling `dispose()`.
5. **`runDir` is created** during `createSandbox()` and is never deleted by the sandbox module
   itself (only by external cleanup scripts).

---

## 6. Config Knobs

### Environment variables (set in host process)

| Variable | Default | Effect |
|---|---|---|
| `LOCALSPRITE_SANDBOX_TTL_MS` | `300000` | Default TTL for all sandboxes (overridden by `options.ttlMs`) |
| `LOCALSPRITE_SANDBOX_MEM_MB` | `1024` | Default memory limit in MiB |
| `LOCALSPRITE_SANDBOX_IMAGE` | `localsprite/sandbox-node:24` | Base image tag to use |
| `LOCALSPRITE_SANDBOX_MAX_CONCURRENT` | `3` | Max sandboxes allowed simultaneously |
| `LOCALSPRITE_RUNS_DIR` | `~/.localsprite/runs` (or `%LOCALAPPDATA%\localsprite\runs` on Windows) | Base directory for run artifacts |
| `DOCKER_SOCKET_PATH` | `/var/run/docker.sock` (Linux/macOS) or `//./pipe/docker_engine` (Windows) | Override Docker socket path |

### `CreateSandboxOptions` fields that change behavior

| Field | Default | Behavior change |
|---|---|---|
| `ttlMs` | 300 000 | Container is force-killed at this many ms after `start()` |
| `memLimitMb` | 1024 | Raises/lowers Docker memory limit |
| `cpuQuota` | 100 000 | Raises/lowers Docker CPU quota |
| `networkMode` | `'bridge'` | `'none'` blocks all external network access from the container |

---

## 7. `SandboxError` Shape

```ts
class SandboxError extends Error {
  readonly code: string;      // one of the codes in §4
  readonly cause?: unknown;   // underlying error if available
  readonly installUrl?: string;  // only present on ERR_DOCKER_UNAVAILABLE
}
```

All sandbox errors are instances of `SandboxError`. Callers MUST check `error instanceof SandboxError`
and `error.code` to distinguish recoverable from fatal errors.

---

## 8. Observable Container Labels

Every container created by this module carries these Docker labels:

| Label | Value |
|---|---|
| `localsprite.managed` | `"true"` |
| `localsprite.run-id` | value of `handle.runId` |

These labels are observable via `docker ps --filter label=localsprite.managed=true`
and are used by the SIGINT cleanup handler to find leaked containers.
