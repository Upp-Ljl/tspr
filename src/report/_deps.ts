/**
 * Local interfaces for external dependencies.
 * These are provided by the caller (buildReport input / DI).
 * DO NOT add implementations here.
 */

export interface LlmClient {
  run(opts: { prompt: string; timeout?: number }): Promise<{ stdout: string; costUsd: number }>;
}

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export class TsprError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "TsprError";
  }
}
