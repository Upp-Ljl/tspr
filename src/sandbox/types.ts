/**
 * Public types for the Docker sandbox module.
 */

export type SandboxStatus = 'running' | 'stopping' | 'disposed';

export interface CreateSandboxOptions {
  /** REQUIRED — absolute path to user project on host */
  projectPath: string;
  /** REQUIRED */
  projectType: 'frontend' | 'backend' | 'fullstack';
  /** extra env vars injected into container */
  env?: Record<string, string>;
  /** container auto-kill after this many ms; default 300_000 */
  ttlMs?: number;
  /** memory limit in MiB; default 1024 */
  memLimitMb?: number;
  /** Docker cpu_quota units; default 100_000 (≈1 CPU) */
  cpuQuota?: number;
  /** default 'bridge'; pass 'none' to block external network */
  networkMode?: string;
}

export interface ExecOptions {
  /** working dir inside container; default /work */
  cwd?: string;
  /** ms before exec is killed; default 60_000 */
  timeout?: number;
  /** merged on top of container env */
  env?: Record<string, string>;
}

export interface ExecResult {
  /** process exit code (0 = success) */
  exitCode: number;
  /** full stdout as UTF-8 string */
  stdout: string;
  /** full stderr as UTF-8 string */
  stderr: string;
  /** wall-clock time from exec start to stream close */
  durationMs: number;
  /** true if process was killed because opts.timeout was reached */
  timedOut: boolean;
}

export type ReadyProbe =
  | { type: 'tcp'; port: number }
  | { type: 'http'; url: string; expectedStatus?: number }
  | { type: 'stdout'; pattern: RegExp };

export interface BootAppOptions {
  /** port inside container to probe (used by tcp probe) */
  port?: number;
  /** how to decide the app is ready; default: tcp on opts.port */
  readyProbe?: ReadyProbe;
  /** ms until giving up; default 30_000 */
  startupTimeoutMs?: number;
  env?: Record<string, string>;
}

export interface AppHandle {
  /** PID of the process inside the container */
  readonly pid: number;
  /** sends SIGTERM; no-op if already stopped */
  kill(): Promise<void>;
  /** resolves with exit code when process ends */
  waitForExit(): Promise<number>;
}

export interface SandboxHandle {
  /** Docker container ID (64-char hex string). Unique per process run. */
  readonly id: string;
  /** UUID identifying this test run. Used as a key in ~/.tspr/runs/. */
  readonly runId: string;
  /** Allocated host TCP port forwarded into the container. */
  readonly port: number;
  /** Absolute path on host where artifacts are written after pullArtifacts(). */
  readonly runDir: string;
  /** Current lifecycle status. */
  readonly status: SandboxStatus;

  /** Run a command to completion inside the container. */
  exec(cmd: string, opts?: ExecOptions): Promise<ExecResult>;
  /** Start a long-running app process inside the container; wait until ready. */
  bootApp(cmd: string, opts: BootAppOptions): Promise<AppHandle>;
  /** Copy artifacts from container to runDir on host. Idempotent. */
  pullArtifacts(): Promise<void>;
  /** Stop and remove the container. Safe to call multiple times (idempotent). */
  dispose(): Promise<void>;
}
