/**
 * src/lib/errors.ts
 * TsprError base class + domain subclasses + MCP JSON-RPC error mapping.
 */

// ─────────────────────────────────────────────
// Canonical error codes
// ─────────────────────────────────────────────
export const ErrCode = Object.freeze({
  // Input / validation
  ERR_INVALID_PORT: 'ERR_INVALID_PORT',
  ERR_INVALID_PARAMS: 'ERR_INVALID_PARAMS',

  // Project checks
  ERR_PROJECT_NOT_FOUND: 'ERR_PROJECT_NOT_FOUND',
  ERR_NOT_NODE_PROJECT: 'ERR_NOT_NODE_PROJECT',
  ERR_NOT_BOOTSTRAPPED: 'ERR_NOT_BOOTSTRAPPED',

  // Docker
  ERR_DOCKER_UNAVAILABLE: 'ERR_DOCKER_UNAVAILABLE',
  ERR_DOCKER_PULL_FAILED: 'ERR_DOCKER_PULL_FAILED',
  ERR_CONTAINER_CRASH: 'ERR_CONTAINER_CRASH',

  // Claude CLI
  ERR_CC_FAILED: 'ERR_CC_FAILED',
  ERR_CC_OUTPUT_INVALID: 'ERR_CC_OUTPUT_INVALID',
  ERR_CC_TIMEOUT: 'ERR_CC_TIMEOUT',

  // I/O
  ERR_WRITE_FAILED: 'ERR_WRITE_FAILED',
  ERR_DB_UNINITIALIZED: 'ERR_DB_UNINITIALIZED',

  // Playwright / frontend
  ERR_PLAYWRIGHT_MISSING: 'ERR_PLAYWRIGHT_MISSING',
  ERR_APP_NOT_REACHABLE: 'ERR_APP_NOT_REACHABLE',
  ERR_EXPLORATION_TIMEOUT: 'ERR_EXPLORATION_TIMEOUT',

  // Test execution
  ERR_NO_TEST_PLAN: 'ERR_NO_TEST_PLAN',
  ERR_NO_PRIOR_RUN: 'ERR_NO_PRIOR_RUN',
  ERR_GENERATED_TESTS_MISSING: 'ERR_GENERATED_TESTS_MISSING',
  ERR_TOOL_TIMEOUT: 'ERR_TOOL_TIMEOUT',

  // Dashboard
  ERR_RENDER_FAILED: 'ERR_RENDER_FAILED',

  // Server lifecycle
  ERR_SERVER_SHUTTING_DOWN: 'ERR_SERVER_SHUTTING_DOWN',

  // Report assembly
  REPORT_SERIALIZATION_FAILED: 'REPORT_SERIALIZATION_FAILED',
} as const);

export type ErrCodeValue = (typeof ErrCode)[keyof typeof ErrCode];

// ─────────────────────────────────────────────
// Base error class
// ─────────────────────────────────────────────
export class TsprError extends Error {
  readonly code: string;
  readonly cause?: unknown;
  readonly data?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    options?: { cause?: unknown; data?: Record<string, unknown> },
  ) {
    super(message);
    this.name = 'TsprError';
    this.code = code;
    this.cause = options?.cause;
    this.data = options?.data;

    // Maintain proper prototype chain in transpiled output
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ─────────────────────────────────────────────
// Domain subclasses
// ─────────────────────────────────────────────

/** Errors originating from sandbox / Docker operations. */
export class SandboxError extends TsprError {
  constructor(
    code: string,
    message: string,
    options?: { cause?: unknown; data?: Record<string, unknown> },
  ) {
    super(code, message, options);
    this.name = 'SandboxError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Errors originating from the claude CLI subprocess. */
export class CcError extends TsprError {
  constructor(
    code: string,
    message: string,
    options?: { cause?: unknown; data?: Record<string, unknown> },
  ) {
    super(code, message, options);
    this.name = 'CcError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Errors originating from auto-patch report assembly. */
export class ReportError extends TsprError {
  constructor(
    code: string,
    message: string,
    options?: { cause?: unknown; data?: Record<string, unknown> },
  ) {
    super(code, message, options);
    this.name = 'ReportError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ─────────────────────────────────────────────
// JSON-RPC error code mapping
// ─────────────────────────────────────────────

/**
 * JSON-RPC 2.0 standard error codes.
 */
const JSONRPC_PARSE_ERROR = -32700;
const JSONRPC_INVALID_REQUEST = -32600;
const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INVALID_PARAMS = -32602;
const JSONRPC_INTERNAL_ERROR = -32603;

/**
 * ERR_INVALID_* codes → -32602 (InvalidParams).
 * Everything else → -32603 (InternalError).
 */
const INVALID_PARAMS_CODES = new Set<string>([
  ErrCode.ERR_INVALID_PORT,
  ErrCode.ERR_INVALID_PARAMS,
]);

export interface McpError {
  code: number;
  message: string;
  data?: object;
}

/**
 * Maps any thrown value to a JSON-RPC error object suitable for MCP responses.
 */
export function toMcpError(err: unknown): McpError {
  if (err instanceof TsprError) {
    const rpcCode = INVALID_PARAMS_CODES.has(err.code)
      ? JSONRPC_INVALID_PARAMS
      : JSONRPC_INTERNAL_ERROR;

    return {
      code: rpcCode,
      message: err.code,
      data: {
        code: err.code,
        message: err.message,
        ...(err.data ?? {}),
      },
    };
  }

  if (err instanceof Error) {
    return {
      code: JSONRPC_INTERNAL_ERROR,
      message: 'ERR_INTERNAL',
      data: { message: err.message },
    };
  }

  return {
    code: JSONRPC_INTERNAL_ERROR,
    message: 'ERR_INTERNAL',
    data: { message: String(err) },
  };
}

// Re-export constants for consumers that need the numeric values
export {
  JSONRPC_PARSE_ERROR,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_METHOD_NOT_FOUND,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_INTERNAL_ERROR,
};
