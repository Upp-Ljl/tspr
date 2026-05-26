/**
 * src/lib/types.ts
 * Shared domain types exported from the lib barrel.
 * Implementation types (db rows, run results, etc.) live here.
 */

// ─────────────────────────────────────────────
// Claude CLI model selection
// ─────────────────────────────────────────────
export type ClaudeModel = 'haiku' | 'sonnet' | 'opus';

// ─────────────────────────────────────────────
// Session / run identity
// ─────────────────────────────────────────────

/** A session bootstrapped via localsprite_bootstrap_tests. */
export interface Session {
  id: string;           // UUID v4
  projectPath: string;
  localPort: number;
  type: 'frontend' | 'backend';
  testScope: 'codebase' | 'diff';
  detectedFramework: string;
  createdAt: string;    // ISO 8601 UTC
  updatedAt: string;    // ISO 8601 UTC
}

/** A single MCP tool invocation recorded in history. */
export interface Run {
  id: string;           // UUID v4
  toolName: string;
  projectPath: string | null;
  startedAt: string;    // ISO 8601 UTC
  completedAt: string | null;
  status: 'ok' | 'error' | 'in-progress';
  errorCode: string | null;
}

/** A single test result entry. */
export interface TestResult {
  id: string;           // UUID v4
  runId: string;
  testId: string;       // stable 12-char hex
  testName: string;
  testFile: string;
  testType: 'frontend-e2e' | 'backend-integration';
  status: 'passed' | 'failed' | 'skipped';
  errorMessage: string | null;
  durationMs: number | null;
  createdAt: string;    // ISO 8601 UTC
}

/** A code summary entry persisted in the DB. */
export interface CodeSummary {
  id: string;           // UUID v4
  projectPath: string;
  framework: string;
  summaryJson: string;  // JSON blob
  createdAt: string;    // ISO 8601 UTC
}

// ─────────────────────────────────────────────
// Auto-patch report types (re-exported from report surface)
// ─────────────────────────────────────────────

export type FailureKind =
  | 'ASSERTION'
  | 'TIMEOUT'
  | 'EXCEPTION'
  | 'NAVIGATION'
  | 'NETWORK'
  | 'VISUAL';

export interface ConsoleEntry {
  level: 'log' | 'warn' | 'error';
  message: string;
  timestamp: string;
}

export interface NetworkError {
  url: string;
  method: string;
  status?: number;
  errorText?: string;
}

export interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body?: string;
}

export interface DbSnapshot {
  tables: Record<string, unknown[]>;
  capturedAt: string;
}

export interface FixRegion {
  file: string;
  lineStart: number;
  lineEnd: number;
  why: string;
}
