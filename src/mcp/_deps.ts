/**
 * Dependency interfaces for MCP module.
 * Round 5 integration: replace with `export * from '../lib'`
 */

export interface CcRunOptions {
  model: 'haiku' | 'sonnet' | 'opus';
  prompt: string;
  timeoutMs?: number;
}

export interface CcRunResult {
  stdout: string;
  costUsd: number;
}

export interface CcClient {
  run(opts: CcRunOptions): Promise<CcRunResult>;
}

export interface Stmt {
  run(...args: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
}

export interface Db {
  exec(sql: string): void;
  prepare(sql: string): Stmt;
  close(): void;
}

export interface Logger {
  info(msg: string, ctx?: object): void;
  warn(msg: string, ctx?: object): void;
  error(msg: string, ctx?: object): void;
  debug(msg: string, ctx?: object): void;
}

export class TsprError extends Error {
  code: string;
  override cause?: unknown;

  constructor(code: string, message: string, cause?: unknown) {
    super(message);
    this.name = 'TsprError';
    this.code = code;
    this.cause = cause;
  }
}

export interface DockerContainer {
  id: string;
  stop(opts?: { t?: number }): Promise<void>;
  remove(): Promise<void>;
}

export interface DockerManager {
  ping(): Promise<void>;
  createContainer(opts: {
    image: string;
    cmd: string[];
    binds: string[];
    labels?: Record<string, string>;
  }): Promise<DockerContainer>;
  teardownAll(): Promise<void>;
}

export interface BrowserPool {
  destroyAll(): Promise<void>;
}
