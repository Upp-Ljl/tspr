import type { ExplorationErrorCode } from './types.js';

export class ExplorationError extends Error {
  public readonly code: ExplorationErrorCode;
  public readonly detail?: string;

  constructor(code: ExplorationErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'ExplorationError';
    this.code = code;
    this.detail = detail;
  }
}
