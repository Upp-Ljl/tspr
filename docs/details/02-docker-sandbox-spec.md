# Module Spec — Docker Ephemeral Sandbox (02)

> SPEC-SPLIT artifact · Layer: dev-spec (implementation detail)
> Date: 2026-05-26
> Status: draft

---

## 0. Purpose

The sandbox module provides an isolated, ephemeral Docker container per test run.
It is the execution boundary for all user-project code.
Every `generate_code_and_execute` / `rerun_tests` MCP tool call goes through this module.
No other module may shell out `docker` directly.

---

## 1. Library Choice: `dockerode` vs spawning `docker` CLI

**Decision: use `dockerode` (npm package, official Docker Engine API client).**

Rationale:

| Concern | `dockerode` | `docker` CLI subprocess |
|---|---|---|
| Structured output | Typed JSON API — no stdout parsing | Must parse human-readable CLI output; breaks on locale/version changes |
| Streaming logs | `container.attach()` streams raw bytes; easy to split stdout/stderr | `docker logs -f` mixes streams; `--log-driver` affects availability |
| Error detection | Numeric `statusCode` from Docker Engine API; predictable | Parse exit code + stderr text; Docker CLI error messages change across versions |
| Windows compat | HTTP over named pipe (`//./pipe/docker_engine`); `dockerode` handles this natively | `docker` CLI must be on PATH; adds a shell-spawn layer on Windows |
| `exec` in running container | `container.exec()` returns `Exec` object with proper attach | `docker exec` subprocess; no structured exit code without `--exit-code` hack |
| Dependency surface | One npm package, no PATH requirement beyond Docker daemon | Docker CLI must be installed separately and on PATH |
| Multiplexing header | `dockerode` demultiplexes Docker's 8-byte multiplexing header automatically | Must DIY or call `docker logs` separately |

`dockerode` is the standard Node.js approach used by projects like `testcontainers-node`.
It connects via the Docker Engine socket (`/var/run/docker.sock` on Linux/macOS,
named pipe on Windows) — the same channel the CLI uses.

---

## 2. Base Image Strategy

### 2.1 Image: `localsprite/sandbox-node:24`

Built from `node:24-slim` plus:
- `playwright` system dependencies (chromium, libnss3, libatk-bridge2.0, etc.)
- `git` (user project may need `git` inside container for fixture setup)
- `curl` (health probe / readiness check inside container)
- `vitest` + `@playwright/test` pre-installed globally in the image (speeds up installs)
- `/work` directory created at build time

This is a custom image we own and version. Tag scheme: `localsprite/sandbox-node:24-<yyyymmdd>`.

### 2.2 First-run build

`scripts/build-sandbox-image.sh` (idempotent):

```bash
#!/usr/bin/env bash
set -euo pipefail

IMAGE="localsprite/sandbox-node:24"
DOCKERFILE="docker/sandbox-node24.Dockerfile"

# Check if image with this Dockerfile digest already exists
LABEL_KEY="localsprite.dockerfile.sha256"
CURRENT_SHA=$(sha256sum "$DOCKERFILE" | awk '{print $1}')
EXISTING_LABEL=$(docker inspect --format "{{index .Config.Labels \"$LABEL_KEY\"}}" "$IMAGE" 2>/dev/null || true)

if [ "$EXISTING_LABEL" = "$CURRENT_SHA" ]; then
  echo "Image $IMAGE is up to date (sha256=$CURRENT_SHA). Skipping build."
  exit 0
fi

echo "Building $IMAGE from $DOCKERFILE..."
docker build \
  --label "$LABEL_KEY=$CURRENT_SHA" \
  -t "$IMAGE" \
  -f "$DOCKERFILE" \
  "$(dirname "$DOCKERFILE")"
echo "Build complete: $IMAGE"
```

The idempotency key is a SHA-256 of the Dockerfile content, stored as a Docker image label.
Subsequent runs compare the stored label against the current Dockerfile digest before building.

### 2.3 Dockerfile location

`docker/sandbox-node24.Dockerfile` in the localsprite repo root.

### 2.4 Cache by digest

After a successful pull or build, `dockerode` records the image digest
(`RepoDigests[0]`) in the module-level `imageDigestCache: Map<string, string>`.
`createSandbox()` checks this cache before calling `docker.pull()` or `docker.buildImage()`.
Re-pulling is only triggered when the cached digest does not match
the tag's remote manifest (checked via `docker.getImage().inspect()`).

---

## 3. Pre-flight: Docker Availability Detection

Sequence:

```
createSandbox() called
        │
        ▼
docker.info()  ─── timeout 2000 ms ───► throws ERR_DOCKER_UNAVAILABLE
        │ ok
        ▼
image present? ──── no ──► build/pull (scripts/build-sandbox-image.sh logic inline)
        │ yes                         └── failure → throws IMAGE_BUILD_FAILED
        ▼
proceed to container creation
```

Implementation:

```ts
// pseudo-code; not final API
async function checkDockerAlive(): Promise<void> {
  try {
    await withTimeout(docker.info(), 2000);
  } catch {
    throw new SandboxError('ERR_DOCKER_UNAVAILABLE', {
      message: 'Docker daemon not reachable within 2 s.',
      installUrl: 'https://docs.docker.com/get-docker/',
    });
  }
}
```

On Windows the socket path is `//./pipe/docker_engine`.
`dockerode` constructor is called with `socketPath` set per platform.

---

## 4. Container Lifecycle

### 4.1 Lifecycle State Machine

```
                  createSandbox()
                       │
                       ▼
              ┌─────────────────┐
              │   CREATING      │  docker.createContainer()
              └────────┬────────┘
                       │ ok
                       ▼
              ┌─────────────────┐
              │   STARTING      │  container.start()
              └────────┬────────┘
                       │ ok
                       ▼
              ┌─────────────────┐   exec() / bootApp()
              │    RUNNING      │ ◄──────────────────────┐
              └────────┬────────┘                        │
                       │                                  │ (re-entrant)
              ┌────────┴──────────┐
              │                   │
         dispose()          TTL exceeded
              │                   │
              ▼                   ▼
       ┌──────────────┐   ┌───────────────┐
       │  STOPPING    │   │  TTL_KILLING  │  SIGKILL via container.kill()
       └──────┬───────┘   └───────┬───────┘
              │                   │
              └─────────┬─────────┘
                        ▼
               ┌─────────────────┐
               │   REMOVING      │  container.remove({ force: true })
               └────────┬────────┘
                        │
                        ▼
               ┌─────────────────┐
               │   DISPOSED      │  removed from activeContainers Set
               └─────────────────┘
```

### 4.2 `createSandbox(options)` — Full Detail

**Signature (implementation-internal):**

```ts
interface CreateSandboxOptions {
  projectPath: string;       // absolute host path to user project
  projectType: 'frontend' | 'backend' | 'fullstack';
  env?: Record<string, string>;
  ttlMs?: number;            // default 300_000 (5 min)
  memLimitMb?: number;       // default 1024 (1 GB)
  cpuQuota?: number;         // docker cpu_quota; default 100000 (1 CPU)
  networkMode?: string;      // default 'bridge' — 'none' blocks external net
}
```

**Docker container create spec:**

```
Image:       localsprite/sandbox-node:24
WorkingDir:  /work
Mounts:
  - Type: bind
    Source: <projectPath>        (resolved, canonical)
    Target: /work
    ReadWrite: true              ← generated test files written here
  - Type: tmpfs
    Target: /tmp/localsprite-out
    Options: size=512m           ← artifact staging area
Env:          from options.env, plus LOCALSPRITE_RUN_ID=<runId>
ExposedPorts: one ephemeral port from range [32768, 60999]
PortBindings: host 0.0.0.0:<allocatedPort> → container <allocatedPort>
HostConfig:
  Memory: <memLimitMb> × 1_048_576
  CpuQuota: <cpuQuota>
  AutoRemove: false              ← we manage removal explicitly
  SecurityOpt: ['no-new-privileges']
  ReadonlyRootfs: false          ← needed for npm install inside container
Labels:
  localsprite.run-id: <runId>
  localsprite.managed: "true"
```

**Port allocation:**

```ts
async function allocateEphemeralPort(): Promise<number> {
  // Bind a TCP server on port 0, record assigned port, close it.
  // Then hand that port to Docker. Race window is acceptable for local use.
}
```

**TTL enforcement:**

After `container.start()` resolves, a `setTimeout(ttlMs)` fires `container.kill({signal:'SIGKILL'})` followed by `container.remove({force:true})`.
The timer `Ref` is stored on the sandbox handle so `dispose()` can cancel it.

### 4.3 Returned Handle (SandboxHandle)

```ts
interface SandboxHandle {
  readonly id: string;          // Docker container ID (64-char hex)
  readonly runId: string;       // localsprite run UUID
  readonly port: number;        // allocated host port
  readonly runDir: string;      // host path: ~/.localsprite/runs/<runId>/
  readonly status: SandboxStatus;  // 'running' | 'stopping' | 'disposed'

  exec(cmd: string, opts?: ExecOptions): Promise<ExecResult>;
  bootApp(cmd: string, opts: BootAppOptions): Promise<AppHandle>;
  pullArtifacts(): Promise<void>;
  dispose(): Promise<void>;
}
```

---

## 5. Exec API

### 5.1 `sandbox.exec(cmd, opts)` — synchronous command execution

```ts
interface ExecOptions {
  cwd?: string;           // default /work
  timeout?: number;       // ms; default 60_000
  env?: Record<string, string>;  // merged on top of container env
}

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;      // true if killed by timeout
}
```

**Implementation:**

1. Call `container.exec({ Cmd: splitCmd(cmd), AttachStdout: true, AttachStderr: true, WorkingDir: cwd, Env: mergedEnv })`.
2. Start the exec; attach to output stream.
3. Demultiplex Docker's multiplexed stream header (8-byte frame: `[type][0][0][0][size×4]`).
   Type `1` = stdout, type `2` = stderr.
4. Accumulate stdout and stderr strings.
5. After stream ends, call `exec.inspect()` to get `ExitCode`.
6. If timeout fires first, call `container.kill({signal:'SIGKILL'})` and set `timedOut: true`.
7. Return `ExecResult`.

The `splitCmd` utility splits a shell string into argv array (simple whitespace split; no shell interpolation — callers must not pass shell metacharacters). For complex commands, callers pass `['sh', '-c', cmd]` explicitly.

### 5.2 `sandbox.bootApp(cmd, opts)` — background long-running process

```ts
interface BootAppOptions {
  port?: number;            // which port inside container to wait for
  readyProbe?: ReadyProbe;  // default: TCP connect to opts.port
  startupTimeoutMs?: number; // default 30_000
  env?: Record<string, string>;
}

type ReadyProbe =
  | { type: 'tcp';  port: number }
  | { type: 'http'; url: string; expectedStatus?: number }
  | { type: 'stdout'; pattern: RegExp };

interface AppHandle {
  readonly pid: number;       // exec PID inside container
  kill(): Promise<void>;      // sends SIGTERM to the exec PID
  waitForExit(): Promise<number>;  // resolves with exit code
}
```

**Implementation:**

1. Call `container.exec({ Cmd: ..., Detach: false, AttachStdout: true, AttachStderr: true })`.
2. Start exec without awaiting stream end (background).
3. Poll readyProbe every 500 ms:
   - `tcp`: attempt `net.createConnection(port, '127.0.0.1')` to the container's allocated host port.
   - `http`: `fetch(url)` check status.
   - `stdout`: buffer accumulated stdout and test against the pattern.
4. Resolve `AppHandle` once probe succeeds, or throw `CONTAINER_START_TIMEOUT` after `startupTimeoutMs`.
5. `AppHandle.kill()` sends `exec.kill()` (SIGTERM). If container is already disposed, no-op.

---

## 6. Artifact Capture

### 6.1 What to capture

| Artifact | Source path in container | Destination on host |
|---|---|---|
| Generated test files | `/work/.localsprite/generated/` | `~/.localsprite/runs/<runId>/generated/` |
| `test_results.json` | `/tmp/localsprite-out/test_results.json` | `~/.localsprite/runs/<runId>/test_results.json` |
| Playwright trace | `/tmp/localsprite-out/playwright-traces/` | `~/.localsprite/runs/<runId>/traces/` |
| Playwright screenshots | `/tmp/localsprite-out/screenshots/` | `~/.localsprite/runs/<runId>/screenshots/` |
| vitest JSON report | `/tmp/localsprite-out/vitest-report.json` | `~/.localsprite/runs/<runId>/vitest-report.json` |

### 6.2 Mechanism

`pullArtifacts()` is called by `dispose()` automatically before container removal.
It also may be called mid-run to stream partial results.

Implementation uses `container.getArchive({ path: '/tmp/localsprite-out' })` which returns
a `tar` stream. We pipe this through Node's `tar` library (or `tar-fs`) to extract
into `runDir`.

`runDir` is created during `createSandbox()`:
`~/.localsprite/runs/<runId>/` with permissions `0o700`.

### 6.3 Partial pull timing

For long-running `generate_code_and_execute` calls:
`pullArtifacts()` is called once immediately after the test runner exits,
before `dispose()`, so results are available even if dispose fails.

---

## 7. Cleanup Tracker

```ts
// src/sandbox/registry.ts
const activeContainers: Set<SandboxHandle> = new Set();

export function register(handle: SandboxHandle): void {
  activeContainers.add(handle);
}

export function unregister(handle: SandboxHandle): void {
  activeContainers.delete(handle);
}

// Called once on module load
process.on('SIGINT',  () => cleanupAll('SIGINT'));
process.on('SIGTERM', () => cleanupAll('SIGTERM'));
process.on('beforeExit', () => cleanupAll('beforeExit'));

async function cleanupAll(reason: string): Promise<void> {
  const handles = [...activeContainers];
  await Promise.allSettled(handles.map(h => h.dispose()));
  if (reason !== 'beforeExit') process.exit(0);
}
```

The `SIGINT` / `SIGTERM` handlers are registered **once** at module-load time,
not per-sandbox creation (avoids MaxListenersExceededWarning on repeated creates).

---

## 8. Concurrency Model

Design supports up to **N=3** concurrent sandboxes (one per parallel UI exploration agent).
Practically MCP calls are serialized by the MCP server to N≤1, but the sandbox module
itself is stateless per handle; concurrent calls are safe.

Constraints:
- Port allocator holds a module-level `Set<number> allocatedPorts` to prevent collisions.
- Port is freed from the set in `dispose()` (not at container removal, to handle the race between removal and a new allocation).
- Memory: 3 × 1 GB = 3 GB peak. Callers may lower `memLimitMb` for parallel scenarios.
- No global lock on `createSandbox()` — each call is independent.

---

## 9. Error Taxonomy

| Code | When thrown | Recovery |
|---|---|---|
| `ERR_DOCKER_UNAVAILABLE` | `docker.info()` times out or throws | User must start Docker Desktop / install Docker |
| `ERR_IMAGE_BUILD_FAILED` | `docker.buildImage()` or pull fails | Check Docker Hub connectivity; inspect build logs |
| `ERR_CONTAINER_START_TIMEOUT` | `container.start()` doesn't complete within 10 s | Docker resource pressure; retry or reduce concurrency |
| `ERR_EXEC_TIMEOUT` | exec runs longer than `opts.timeout` | Caller reduces timeout or user project has infinite loop |
| `ERR_PORT_UNAVAILABLE` | All ports in [32768, 60999] claimed by `allocatedPorts` | Too many concurrent sandboxes; dispose before creating new |
| `ERR_OUT_OF_MEMORY` | Docker OOM kills container (exit code 137) | Raise `memLimitMb` or profile user project |
| `ERR_ARTIFACT_PULL_FAILED` | `container.getArchive()` throws | Non-fatal if test results already written to `/work`; logged and swallowed |

All errors are instances of `SandboxError extends Error` with a `code` string field
matching the table above and an optional `cause: unknown` field.

---

## 10. File Layout

```
src/
  sandbox/
    index.ts              ← public re-export: createSandbox, withSandbox, SandboxError
    docker.ts             ← createSandbox(), SandboxHandle class internals
    registry.ts           ← activeContainers Set + SIGINT/SIGTERM cleanup
    ports.ts              ← allocateEphemeralPort(), releasePort()
    artifacts.ts          ← pullArtifacts() implementation
    image.ts              ← checkAndEnsureImage(), checkDockerAlive()
    errors.ts             ← SandboxError class + error code constants

docker/
  sandbox-node24.Dockerfile   ← base image definition

scripts/
  build-sandbox-image.sh      ← idempotent image build script
```

---

## 11. Bootstrap Script Detail

`scripts/build-sandbox-image.sh` runs:

1. Checks that `docker` CLI is on PATH (different from daemon availability — this script is run by the developer, not by the Node module).
2. Computes `sha256` of `docker/sandbox-node24.Dockerfile`.
3. Runs `docker inspect localsprite/sandbox-node:24` and reads the label `localsprite.dockerfile.sha256`.
4. If digests match → exits 0 ("up to date").
5. Otherwise runs `docker build` with the label baked in, tagging `localsprite/sandbox-node:24`.
6. On failure prints the build log tail and exits non-zero.

The `npm run build-sandbox-image` script in `package.json` calls this shell script.

---

## 12. `withSandbox` Try/Finally Wrapper

```ts
async function withSandbox<T>(
  options: CreateSandboxOptions,
  fn: (sandbox: SandboxHandle) => Promise<T>
): Promise<T> {
  const sandbox = await createSandbox(options);
  try {
    return await fn(sandbox);
  } finally {
    await sandbox.dispose();
  }
}
```

This is the canonical call pattern for MCP tool implementations.
They never call `createSandbox()` directly; they always use `withSandbox()`.

---

## 13. Platform Notes (Windows)

On Windows, `dockerode` connects via:
```ts
new Dockerode({ socketPath: '//./pipe/docker_engine' })
```

`/var/run/docker.sock` is replaced automatically when the platform is detected as `win32`.
The `checkDockerAlive()` pre-flight uses the same dockerode instance, so
the platform switching is centralized in `image.ts`.

Port binding `0.0.0.0` works on both platforms for Docker Desktop on Windows.
The container `runDir` base is:
- Linux/macOS: `~/.localsprite/runs/`
- Windows: `%LOCALAPPDATA%\localsprite\runs\`

---

## 14. Sequence Diagram — `generate_code_and_execute` full flow

```
MCP tool call: generate_code_and_execute
        │
        ▼
  withSandbox({ projectPath, projectType })
        │
        ├─ checkDockerAlive()                   [≤2 s]
        ├─ checkAndEnsureImage()                [0 s if cached]
        ├─ allocateEphemeralPort()
        ├─ docker.createContainer(spec)
        ├─ container.start()
        │
        ▼  sandbox.exec("npm install", { timeout: 120_000 })
        │  → { exitCode, stdout, stderr }
        │
        ▼  sandbox.bootApp(userCmd, { readyProbe: { type:'tcp', port } })
        │  → AppHandle (app running in background)
        │
        ▼  sandbox.exec(testRunCmd, { timeout: 300_000 })
        │  → ExecResult (vitest / playwright test run)
        │
        ▼  sandbox.pullArtifacts()
        │  → test_results.json, traces/ on host runDir
        │
        ▼  appHandle.kill()
        │
        ▼  dispose() [finally block]
        │  ├─ cancel TTL timer
        │  ├─ container.kill({signal:'SIGKILL'})
        │  ├─ container.remove({force:true})
        │  └─ unregister from activeContainers
        │
        ▼
  return structured result to MCP client
```

---

## 15. Dockerfile Sketch (non-normative)

```dockerfile
FROM node:24-slim

# Playwright system dependencies (Chromium path)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdrm2 libdbus-1-3 libxkbcommon0 libatspi2.0-0 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libasound2 \
  && rm -rf /var/lib/apt/lists/*

# Pre-install test tooling globally to speed per-run npm install
RUN npm install -g vitest@latest @playwright/test@latest

# Install Playwright browsers
RUN npx playwright install chromium --with-deps

RUN mkdir -p /work /tmp/localsprite-out
WORKDIR /work

LABEL localsprite.base-image="node24-slim"
```

---

## 16. Dependencies

| Package | Version constraint | Purpose |
|---|---|---|
| `dockerode` | `^3.3` | Docker Engine API client |
| `tar-fs` | `^3.0` | Unpack `container.getArchive()` tar stream |
| `uuid` | `^10` | Generate `runId` |

These are runtime dependencies of the sandbox module.
`dockerode` is the only external process boundary; no `child_process.spawn('docker', ...)` anywhere.
