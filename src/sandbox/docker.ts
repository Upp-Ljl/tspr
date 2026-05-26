import Dockerode from 'dockerode';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import {
  CreateSandboxOptions,
  ExecOptions,
  ExecResult,
  BootAppOptions,
  AppHandle,
  SandboxHandle,
  SandboxStatus,
  ReadyProbe,
} from './types.js';
import { SandboxError, ERROR_CODES } from './errors.js';
import { createDockerClient, checkDockerAlive, checkAndEnsureImage } from './image.js';
import { allocateEphemeralPort, releasePort } from './ports.js';
import { pullArtifacts } from './artifacts.js';
import { register, unregister, getActiveCount } from './registry.js';

const DEFAULT_TTL_MS = 300_000;
const DEFAULT_MEM_LIMIT_MB = 1024;
const DEFAULT_CPU_QUOTA = 100_000;
const DEFAULT_MAX_CONCURRENT = 3;
const CONTAINER_START_TIMEOUT_MS = 10_000;

function getRunsDir(): string {
  if (process.env.TSPR_RUNS_DIR) {
    return process.env.TSPR_RUNS_DIR;
  }
  if (os.platform() === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'tspr', 'runs');
  }
  return path.join(os.homedir(), '.tspr', 'runs');
}

function getImageName(): string {
  return process.env.TSPR_SANDBOX_IMAGE ?? 'tspr/sandbox-node:24';
}

function getMaxConcurrent(): number {
  const val = process.env.TSPR_SANDBOX_MAX_CONCURRENT;
  if (val) {
    const parsed = parseInt(val, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_MAX_CONCURRENT;
}

/** Demultiplex Docker's 8-byte multiplexed stream */
function demuxDockerStream(chunk: Buffer, stdout: Buffer[], stderr: Buffer[]): void {
  let offset = 0;
  while (offset < chunk.length) {
    if (offset + 8 > chunk.length) break;
    const streamType = chunk[offset];
    const size =
      (chunk[offset + 4] << 24) |
      (chunk[offset + 5] << 16) |
      (chunk[offset + 6] << 8) |
      chunk[offset + 7];
    offset += 8;
    if (offset + size > chunk.length) {
      const payload = chunk.subarray(offset, chunk.length);
      if (streamType === 1) stdout.push(Buffer.from(payload));
      else if (streamType === 2) stderr.push(Buffer.from(payload));
      break;
    }
    const payload = chunk.subarray(offset, offset + size);
    if (streamType === 1) stdout.push(Buffer.from(payload));
    else if (streamType === 2) stderr.push(Buffer.from(payload));
    offset += size;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tcpConnect(host: string, port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`TCP connect timed out`));
    }, timeoutMs);

    socket.on('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

class AppHandleImpl implements AppHandle {
  private _pid: number;
  private _killed = false;
  private _exitCode: number | null = null;
  private _exitResolvers: Array<(code: number) => void> = [];
  private _container: Dockerode.Container;

  constructor(pid: number, container: Dockerode.Container) {
    this._pid = pid;
    this._container = container;
  }

  get pid(): number {
    return this._pid;
  }

  setPid(pid: number): void {
    this._pid = pid;
  }

  notifyExit(code: number): void {
    if (this._exitCode !== null) return; // Already exited
    this._exitCode = code;
    for (const resolve of this._exitResolvers) resolve(code);
    this._exitResolvers = [];
  }

  async kill(): Promise<void> {
    if (this._killed) return;
    this._killed = true;
    try {
      if (this._pid > 0) {
        // Run kill -TERM in the container to send SIGTERM to the process
        const killExec = await this._container.exec({
          Cmd: ['kill', '-TERM', String(this._pid)],
          AttachStdout: false,
          AttachStderr: false,
        });
        const killStream = await killExec.start({ hijack: true, stdin: false });
        await new Promise<void>((resolve) => {
          killStream.on('end', resolve);
          killStream.on('error', resolve);
          // Timeout in case it hangs
          setTimeout(resolve, 2000);
        });
      }
    } catch {
      // ignore — process may already be gone
    }
    // Notify exit with -1 if not already done
    if (this._exitCode === null) {
      this.notifyExit(-1);
    }
  }

  async waitForExit(): Promise<number> {
    if (this._exitCode !== null) return this._exitCode;
    return new Promise<number>((resolve) => {
      this._exitResolvers.push(resolve);
    });
  }
}

class SandboxHandleImpl implements SandboxHandle {
  readonly id: string;
  readonly runId: string;
  readonly port: number;
  readonly runDir: string;
  private _status: SandboxStatus = 'running';
  private _container: Dockerode.Container;
  private _ttlTimer: ReturnType<typeof setTimeout> | null = null;
  private _oomState = false;
  private _disposePromise: Promise<void> | null = null;

  constructor(
    container: Dockerode.Container,
    _docker: Dockerode,
    runId: string,
    port: number,
    runDir: string,
    ttlMs: number
  ) {
    this.id = container.id;
    this.runId = runId;
    this.port = port;
    this.runDir = runDir;
    this._container = container;

    // TTL timer
    this._ttlTimer = setTimeout(async () => {
      this._ttlTimer = null;
      await this._doDispose().catch(() => {});
    }, ttlMs);
    // Don't block process exit on this timer
    if (this._ttlTimer.unref) this._ttlTimer.unref();
  }

  get status(): SandboxStatus {
    return this._status;
  }

  async exec(cmd: string, opts?: ExecOptions): Promise<ExecResult> {
    // Check OOM state first
    if (this._oomState) {
      throw new SandboxError(
        ERROR_CODES.OUT_OF_MEMORY,
        'Container was OOM-killed — no further exec possible'
      );
    }

    // Check status — use string to avoid TypeScript narrowing issues
    const statusNow = this._status as string;
    if (statusNow !== 'running') {
      throw new SandboxError(
        ERROR_CODES.SANDBOX_DISPOSED,
        `Sandbox is no longer alive (status: ${statusNow})`
      );
    }

    const cwd = opts?.cwd ?? '/work';
    const timeoutMs = opts?.timeout ?? 60_000;

    // Build merged env array
    const envArray: string[] = [];
    if (opts?.env) {
      for (const [k, v] of Object.entries(opts.env)) {
        envArray.push(`${k}=${v}`);
      }
    }

    let execObj: Dockerode.Exec;
    try {
      execObj = await this._container.exec({
        Cmd: ['sh', '-c', cmd],
        AttachStdout: true,
        AttachStderr: true,
        WorkingDir: cwd,
        Env: envArray.length > 0 ? envArray : undefined,
      });
    } catch (err) {
      throw new SandboxError(
        ERROR_CODES.SANDBOX_DISPOSED,
        `Failed to create exec (sandbox may be stopped): ${String(err)}`,
        { cause: err }
      );
    }

    const t0 = Date.now();
    let timedOut = false;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let streamResult: Dockerode.ExecInspectInfo | null = null;

    try {
      const stream = await execObj.start({ hijack: true, stdin: false });

      // IMPORTANT: Set up stream listeners BEFORE any async operations.
      // Fast commands (e.g. 'exit 0') may complete and fire 'end'/'close' before
      // listeners are attached if we await anything (like exec.inspect()) first.
      let execPid = 0; // will be populated concurrently
      await new Promise<void>((resolve, reject) => {
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
        let streamResolved = false;

        const done = () => {
          if (streamResolved) return;
          streamResolved = true;
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
            timeoutHandle = null;
          }
          if (!timedOut) resolve();
        };

        stream.on('data', (chunk: Buffer) => {
          demuxDockerStream(chunk, stdoutChunks, stderrChunks);
        });

        // Docker hijack streams may emit 'end' or 'close' depending on platform/version
        stream.on('end', done);
        stream.on('close', done);

        stream.on('error', (err: Error) => {
          if (streamResolved) return;
          streamResolved = true;
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
            timeoutHandle = null;
          }
          if (!timedOut) reject(err);
          else resolve();
        });

        if (timeoutMs > 0) {
          timeoutHandle = setTimeout(async () => {
            timedOut = true;
            timeoutHandle = null;
            // Kill just the exec process, not the whole container
            try {
              if (execPid > 0) {
                const killExec = await this._container.exec({
                  Cmd: ['kill', '-9', String(execPid)],
                  AttachStdout: false,
                  AttachStderr: false,
                });
                const ks = await killExec.start({ hijack: true, stdin: false });
                ks.on('end', () => {});
                ks.on('close', () => {});
                ks.resume();
              }
            } catch {
              // ignore
            }
            // Resolve even if stream hasn't ended
            if (!streamResolved) {
              streamResolved = true;
              resolve();
            }
          }, timeoutMs);
        }

        // Fetch PID asynchronously — does NOT block stream listener setup
        execObj.inspect().then((info) => { execPid = info.Pid ?? 0; }).catch(() => {});
      });

      // Wait a brief moment for inspect to have final exit code
      await sleep(100);
      try {
        streamResult = await execObj.inspect();
      } catch {
        streamResult = null;
      }
    } catch (err) {
      const statusAtCatch = this._status as string;
      if (statusAtCatch !== 'running') {
        throw new SandboxError(
          ERROR_CODES.SANDBOX_DISPOSED,
          'Sandbox is no longer alive'
        );
      }
      throw err;
    }

    const durationMs = Date.now() - t0;
    const exitCode = timedOut ? -1 : (streamResult?.ExitCode ?? -1);

    // Check OOM: exit code 137 + OOMKilled inspect
    if (!timedOut && exitCode === 137) {
      try {
        const containerInfo = await this._container.inspect();
        if (containerInfo.State?.OOMKilled) {
          this._oomState = true;
        }
      } catch {
        // container may be gone
      }
    }

    if (this._oomState) {
      throw new SandboxError(
        ERROR_CODES.OUT_OF_MEMORY,
        'Container was OOM-killed'
      );
    }

    return {
      exitCode,
      stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
      stderr: Buffer.concat(stderrChunks).toString('utf-8'),
      durationMs,
      timedOut,
    };
  }

  async bootApp(cmd: string, opts: BootAppOptions): Promise<AppHandle> {
    const statusNow = this._status as string;
    if (statusNow !== 'running') {
      throw new SandboxError(
        ERROR_CODES.SANDBOX_DISPOSED,
        `Sandbox is no longer alive (status: ${statusNow})`
      );
    }

    const startupTimeoutMs = opts.startupTimeoutMs ?? 30_000;
    const probe: ReadyProbe | null =
      opts.readyProbe ??
      (opts.port ? { type: 'tcp', port: opts.port } : null);

    const envArray: string[] = [];
    if (opts.env) {
      for (const [k, v] of Object.entries(opts.env)) {
        envArray.push(`${k}=${v}`);
      }
    }

    const execObj = await this._container.exec({
      Cmd: ['sh', '-c', cmd],
      AttachStdout: true,
      AttachStderr: true,
      Env: envArray.length > 0 ? envArray : undefined,
    });

    const stream = await execObj.start({ hijack: true, stdin: false });

    // Get PID from exec inspect (may take a moment)
    let execPid = 0;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const inspectInfo = await execObj.inspect();
        execPid = inspectInfo.Pid ?? 0;
        if (execPid > 0) break;
      } catch {
        // not yet
      }
      await sleep(100);
    }

    const appHandle = new AppHandleImpl(execPid, this._container);

    // Accumulate stdout chunks for stdout probe
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutPatternResolved = false;
    let stdoutPatternResolve: (() => void) | null = null;

    stream.on('data', (chunk: Buffer) => {
      demuxDockerStream(chunk, stdoutChunks, stderrChunks);
      if (probe?.type === 'stdout' && !stdoutPatternResolved) {
        const text = Buffer.concat(stdoutChunks).toString('utf-8');
        if (probe.pattern.test(text)) {
          stdoutPatternResolved = true;
          stdoutPatternResolve?.();
        }
      }
    });

    stream.on('end', () => {
      execObj.inspect().then((info) => {
        appHandle.notifyExit(info.ExitCode ?? -1);
      }).catch(() => {
        appHandle.notifyExit(-1);
      });
    });

    stream.on('error', () => {
      appHandle.notifyExit(-1);
    });

    // Wait for ready probe
    if (probe) {
      await this._waitForProbe(probe, startupTimeoutMs, () => {
        return new Promise<void>((resolve) => {
          if (stdoutPatternResolved) {
            resolve();
          } else {
            stdoutPatternResolve = resolve;
          }
        });
      });
    }

    // Try to get PID again if we didn't get it initially
    if (execPid === 0) {
      try {
        const inspectInfo = await execObj.inspect();
        const newPid = inspectInfo.Pid ?? 0;
        if (newPid > 0) {
          appHandle.setPid(newPid);
        }
      } catch {
        // ignore
      }
    }

    return appHandle;
  }

  /**
   * Check if a TCP port is accepting connections from inside the container.
   * This is required on Windows Docker Desktop, which creates a host-side proxy
   * that always accepts connections even when nothing in the container is listening.
   * Returns true if a service inside the container is accepting connections on the port.
   */
  private async _tcpProbeInContainer(port: number): Promise<boolean> {
    try {
      const checkExec = await this._container.exec({
        Cmd: [
          'node',
          '-e',
          `const net=require('net');const s=net.createConnection({port:${port},host:'127.0.0.1'});s.setTimeout(800);s.on('connect',()=>{process.stdout.write('CONNECTED\\n');process.exit(0)});s.on('error',e=>{process.stdout.write('ERR:'+e.code+'\\n');process.exit(1)});s.on('timeout',()=>{process.stdout.write('TIMEOUT\\n');process.exit(1)});`,
        ],
        AttachStdout: true,
        AttachStderr: true,
      });
      const s = await checkExec.start({ hijack: true, stdin: false });

      // Phase 1: wait for stream end (or safety timeout). Listeners set up BEFORE
      // any await — fast exec commands fire 'end'/'close' before listeners are
      // attached if we await anything in between.
      await new Promise<void>((resolve) => {
        let resolved = false;
        const done = () => { if (!resolved) { resolved = true; resolve(); } };
        s.on('end', done);
        s.on('close', done);
        s.on('error', done);
        // Safety — must be longer than inner node timeout (800ms)
        setTimeout(done, 1500);
        // Consume stream so it can emit end/close
        s.resume();
      });

      // Phase 2: poll inspect until Running=false. dockerode's exec.inspect()
      // can briefly show Running=true / ExitCode=null right after stream end
      // (race between stream EOF and container's process bookkeeping). Without
      // polling, we'd read null → treat as failure → probe never converges.
      for (let i = 0; i < 10; i++) {
        try {
          const info = await checkExec.inspect();
          if (!info.Running) {
            return (info.ExitCode ?? 1) === 0;
          }
        } catch {
          return false;
        }
        await sleep(50);
      }
      return false;
    } catch {
      return false;
    }
  }

  private async _waitForProbe(
    probe: ReadyProbe,
    timeoutMs: number,
    stdoutProbeReady: () => Promise<void>
  ): Promise<void> {
    if (probe.type === 'stdout') {
      await Promise.race([
        stdoutProbeReady(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new SandboxError(
                  ERROR_CODES.CONTAINER_START_TIMEOUT,
                  `App did not write expected stdout pattern within ${timeoutMs}ms`
                )
              ),
            timeoutMs
          )
        ),
      ]);
      return;
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (probe.type === 'tcp') {
          // Probe from inside the container (works on all Docker backends including
          // Windows Docker Desktop which creates a host-side proxy even for unbound ports)
          const checkResult = await this._tcpProbeInContainer(probe.port);
          if (checkResult) return;
        } else if (probe.type === 'http') {
          const expectedStatus = probe.expectedStatus ?? 200;
          const response = await fetch(probe.url, {
            signal: AbortSignal.timeout(2000),
          });
          if (response.status === expectedStatus) return;
        }
      } catch {
        // Not ready yet
      }
      await sleep(500);
    }

    throw new SandboxError(
      ERROR_CODES.CONTAINER_START_TIMEOUT,
      `App did not become ready within ${timeoutMs}ms`
    );
  }

  async pullArtifacts(): Promise<void> {
    await pullArtifacts(this._container, this.runDir);
  }

  async dispose(): Promise<void> {
    if (this._disposePromise) return this._disposePromise;
    if ((this._status as string) === 'disposed') return;

    this._disposePromise = this._doDispose();
    return this._disposePromise;
  }

  async _doDispose(): Promise<void> {
    if ((this._status as string) === 'disposed') return;

    this._status = 'stopping';

    // Cancel TTL timer
    if (this._ttlTimer) {
      clearTimeout(this._ttlTimer);
      this._ttlTimer = null;
    }

    // Try to pull artifacts before removing
    try {
      await pullArtifacts(this._container, this.runDir);
    } catch {
      // Non-fatal
    }

    // Kill and remove container
    try {
      await this._container.kill({ signal: 'SIGKILL' });
    } catch {
      // container may already be stopped
    }

    try {
      await this._container.remove({ force: true });
    } catch {
      // container may already be removed
    }

    this._status = 'disposed';
    releasePort(this.port);
    unregister(this);
  }
}

/**
 * Creates and starts one ephemeral Docker container.
 * Throws SandboxError on any failure.
 */
export async function createSandbox(options: CreateSandboxOptions): Promise<SandboxHandle> {
  const maxConcurrent = getMaxConcurrent();
  const currentCount = getActiveCount();

  if (currentCount >= maxConcurrent) {
    throw new SandboxError(
      ERROR_CODES.MAX_CONCURRENT_EXCEEDED,
      `Maximum concurrent sandboxes (${maxConcurrent}) already reached. Dispose existing sandboxes before creating new ones.`
    );
  }

  const docker = createDockerClient();

  // Pre-flight: Docker availability
  await checkDockerAlive(docker);

  // Ensure image exists
  await checkAndEnsureImage(docker);

  // Allocate ephemeral port (same on host and container sides per B-2-27)
  const port = await allocateEphemeralPort();

  const runId = randomUUID();
  const runsDir = getRunsDir();
  const runDir = path.join(runsDir, runId);

  // Create runDir with proper permissions
  fs.mkdirSync(runDir, { recursive: true });
  try {
    fs.chmodSync(runDir, 0o700);
  } catch {
    // chmod may not be supported on Windows
  }

  const ttlMs =
    options.ttlMs ??
    (process.env.TSPR_SANDBOX_TTL_MS
      ? parseInt(process.env.TSPR_SANDBOX_TTL_MS, 10)
      : DEFAULT_TTL_MS);

  const memLimitMb =
    options.memLimitMb ??
    (process.env.TSPR_SANDBOX_MEM_MB
      ? parseInt(process.env.TSPR_SANDBOX_MEM_MB, 10)
      : DEFAULT_MEM_LIMIT_MB);

  const cpuQuota = options.cpuQuota ?? DEFAULT_CPU_QUOTA;
  const networkMode = options.networkMode ?? 'bridge';
  const imageName = getImageName();

  // Build env array
  const envArray: string[] = [`TSPR_RUN_ID=${runId}`];
  if (options.env) {
    for (const [k, v] of Object.entries(options.env)) {
      envArray.push(`${k}=${v}`);
    }
  }

  // Port binding: host port = container port (B-2-27)
  const portBindings: Record<string, Array<{ HostIp: string; HostPort: string }>> = {
    [`${port}/tcp`]: [{ HostIp: '0.0.0.0', HostPort: String(port) }],
  };

  const exposedPorts: Record<string, Record<string, never>> = {
    [`${port}/tcp`]: {},
  };

  let container: Dockerode.Container;
  try {
    container = await docker.createContainer({
      Image: imageName,
      Cmd: ['sh', '-c', 'while true; do sleep 3600; done'],
      WorkingDir: '/work',
      Env: envArray,
      ExposedPorts: exposedPorts,
      Labels: {
        'tspr.managed': 'true',
        'tspr.run-id': runId,
      },
      HostConfig: {
        // Bind-mount projectPath at /work and runDir at /tmp/tspr-out.
        // Using a bind mount for artifacts (vs tmpfs) allows the host to read files
        // written by the container without needing getArchive (which fails on Windows
        // Docker Desktop for tmpfs paths).
        Binds: [
          `${options.projectPath}:/work`,
          `${runDir}:/tmp/tspr-out`,
        ],
        Memory: memLimitMb * 1_048_576,
        CpuQuota: cpuQuota,
        AutoRemove: false,
        SecurityOpt: ['no-new-privileges'],
        PortBindings: portBindings,
        NetworkMode: networkMode,
      },
    });
  } catch (err) {
    releasePort(port);
    throw new SandboxError(
      ERROR_CODES.CONTAINER_START_TIMEOUT,
      `Failed to create container: ${String(err)}`,
      { cause: err }
    );
  }

  // Start container with timeout
  try {
    await Promise.race([
      container.start(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('Container start timed out')),
          CONTAINER_START_TIMEOUT_MS
        )
      ),
    ]);
  } catch (err) {
    releasePort(port);
    try {
      await container.remove({ force: true });
    } catch {
      /* ignore */
    }
    throw new SandboxError(
      ERROR_CODES.CONTAINER_START_TIMEOUT,
      `Container did not start within ${CONTAINER_START_TIMEOUT_MS}ms: ${String(err)}`,
      { cause: err }
    );
  }

  const handle = new SandboxHandleImpl(container, docker, runId, port, runDir, ttlMs);
  register(handle);
  return handle;
}

/**
 * withSandbox: try/finally convenience wrapper (B-2-19, B-2-20).
 */
export async function withSandbox<T>(
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
