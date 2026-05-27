/**
 * src/lib/index.ts
 * Barrel export for all shared library utilities.
 */

// cc.ts — LlmClient factory (delegates to provider layer)
export type { LlmRunOptions, LlmRunResult, LlmClient, LlmClientConfig, ClaudeModel } from './cc.js';
export { createLlmClient } from './cc.js';

// config.ts — ~/.tspr/config.json loader + Zod schema
export type { TsprConfig } from './config.js';
export { loadConfig, TsprConfigSchema } from './config.js';

// providers — LlmProvider interface + all providers + factory
export type { LlmProvider, ModelAliasMap } from './providers/index.js';
export {
  ClaudeSubprocessProvider,
  OpenAICompatProvider,
  MinimaxProvider,
  createProvider,
  CLAUDE_SUBPROCESS_DEFAULTS,
  OPENAI_COMPAT_DEFAULTS,
  MINIMAX_DEFAULTS,
  resolveModelId,
} from './providers/index.js';

// db.ts — SQLite wrapper + schema
export type { Db, Stmt } from './db.js';
export { openDb, initSchema } from './db.js';

// log.ts — structured stderr logger
export type { Logger, LogLevel, LoggerOptions } from './log.js';
export { createLogger } from './log.js';

// errors.ts — error classes + MCP mapping
export {
  TsprError,
  SandboxError,
  LlmError,
  ReportError,
  ErrCode,
  toMcpError,
  // numeric RPC code constants
  JSONRPC_PARSE_ERROR,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_METHOD_NOT_FOUND,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_INTERNAL_ERROR,
} from './errors.js';
export type { ErrCodeValue, McpError } from './errors.js';

// paths.ts — filesystem helpers
export {
  tsprHome,
  runsDir,
  dbPath,
  configPath,
  ensureDir,
} from './paths.js';

// types.ts — shared domain types
export type {
  Session,
  Run,
  TestResult,
  CodeSummary,
  FailureKind,
  ConsoleEntry,
  NetworkError,
  HttpRequest,
  HttpResponse,
  DbSnapshot,
  FixRegion,
} from './types.js';
