// Local interfaces for shared dependencies.
// DO NOT import from src/lib/ — those are out of scope for this module.

export interface CcClient {
  run(opts: { model: string; prompt: string; timeoutMs?: number }): Promise<{ stdout: string; costUsd: number }>;
}

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
}

export class LocalSpriteError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = 'LocalSpriteError';
  }
}
