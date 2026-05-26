import { LocalSpriteError } from './_deps.js';

/**
 * Error codes for sandbox operations.
 */
export const ERROR_CODES = {
  DOCKER_UNAVAILABLE: 'ERR_DOCKER_UNAVAILABLE',
  IMAGE_BUILD_FAILED: 'ERR_IMAGE_BUILD_FAILED',
  CONTAINER_START_TIMEOUT: 'ERR_CONTAINER_START_TIMEOUT',
  EXEC_TIMEOUT: 'ERR_EXEC_TIMEOUT',
  PORT_UNAVAILABLE: 'ERR_PORT_UNAVAILABLE',
  MAX_CONCURRENT_EXCEEDED: 'ERR_MAX_CONCURRENT_EXCEEDED',
  OUT_OF_MEMORY: 'ERR_OUT_OF_MEMORY',
  ARTIFACT_PULL_FAILED: 'ERR_ARTIFACT_PULL_FAILED',
  /** Internal: sandbox is no longer alive (disposed or stopping) */
  SANDBOX_DISPOSED: 'ERR_SANDBOX_DISPOSED',
} as const;

export type SandboxErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/**
 * All sandbox errors are instances of SandboxError.
 * Callers MUST check error instanceof SandboxError and error.code.
 */
export class SandboxError extends LocalSpriteError {
  /** Docker install docs URL — only present on ERR_DOCKER_UNAVAILABLE */
  readonly installUrl?: string;

  constructor(
    code: SandboxErrorCode,
    message: string,
    options?: { cause?: unknown; installUrl?: string }
  ) {
    super(code, message, options?.cause);
    this.name = 'SandboxError';
    if (options?.installUrl !== undefined) {
      this.installUrl = options.installUrl;
    }
  }
}
