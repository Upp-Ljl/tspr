/**
 * Local interface declarations for shared dependencies.
 * This module declares only interfaces — it does not import from src/lib/.
 */

export interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}

export class TsprError extends Error {
  readonly code: string;
  readonly cause?: unknown;

  constructor(code: string, message: string, cause?: unknown) {
    super(message);
    this.name = 'TsprError';
    this.code = code;
    this.cause = cause;
  }
}

/** No-op logger used when no logger is provided */
export const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};
