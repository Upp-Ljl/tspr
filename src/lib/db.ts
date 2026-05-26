/**
 * src/lib/db.ts
 * better-sqlite3 wrapper with schema initialization.
 * All tables are created with IF NOT EXISTS — initSchema is idempotent.
 */

import BetterSqlite3 from 'better-sqlite3';
import { dbPath, ensureDir } from './paths.js';
import path from 'node:path';

// ─────────────────────────────────────────────
// Public interface types
// ─────────────────────────────────────────────

export interface Stmt<T = unknown> {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): T | undefined;
  all(...params: unknown[]): T[];
  iterate(...params: unknown[]): IterableIterator<T>;
}

export interface Db {
  exec(sql: string): void;
  prepare<T = unknown>(sql: string): Stmt<T>;
  transaction<R>(fn: () => R): R;
  close(): void;
}

// ─────────────────────────────────────────────
// Adapter — wraps BetterSqlite3.Database in our interface
// ─────────────────────────────────────────────

class DbImpl implements Db {
  private readonly _db: BetterSqlite3.Database;

  constructor(db: BetterSqlite3.Database) {
    this._db = db;
  }

  exec(sql: string): void {
    this._db.exec(sql);
  }

  prepare<T = unknown>(sql: string): Stmt<T> {
    const stmt = this._db.prepare(sql);
    return {
      run: (...params: unknown[]) => {
        const info = stmt.run(...params);
        return {
          changes: info.changes,
          lastInsertRowid: info.lastInsertRowid,
        };
      },
      get: (...params: unknown[]): T | undefined => {
        return stmt.get(...params) as T | undefined;
      },
      all: (...params: unknown[]): T[] => {
        return stmt.all(...params) as T[];
      },
      iterate: (...params: unknown[]): IterableIterator<T> => {
        return stmt.iterate(...params) as IterableIterator<T>;
      },
    };
  }

  transaction<R>(fn: () => R): R {
    return this._db.transaction(fn)();
  }

  close(): void {
    this._db.close();
  }
}

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

/**
 * Open (or create) the SQLite database at `filePath`.
 * Defaults to `~/.localsprite/db.sqlite`.
 * The parent directory is created if it does not exist.
 * Call `initSchema(db)` after opening to ensure tables exist.
 */
export function openDb(filePath?: string): Db {
  const resolvedPath = filePath ?? dbPath();

  // Ensure parent directory exists (no-op for :memory:)
  if (resolvedPath !== ':memory:') {
    ensureDir(path.dirname(resolvedPath));
  }

  const raw = new BetterSqlite3(resolvedPath, {
    // WAL mode for better concurrent read performance
    // (even in single-process, faster than journal mode for our workload)
  });

  // Enable WAL for non-in-memory databases
  if (resolvedPath !== ':memory:') {
    raw.pragma('journal_mode = WAL');
  }

  // Enforce FK constraints
  raw.pragma('foreign_keys = ON');

  return new DbImpl(raw);
}

/**
 * Create all localsprite tables (idempotent — uses IF NOT EXISTS).
 * Safe to call on an already-initialized database.
 */
export function initSchema(db: Db): void {
  db.exec(`
    -- ──────────────────────────────────────────
    -- sessions: bootstrapped project sessions
    -- ──────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS sessions (
      id                TEXT PRIMARY KEY,
      project_path      TEXT NOT NULL,
      local_port        INTEGER NOT NULL DEFAULT 5173,
      type              TEXT NOT NULL CHECK(type IN ('frontend','backend')),
      test_scope        TEXT NOT NULL CHECK(test_scope IN ('codebase','diff')),
      detected_framework TEXT NOT NULL DEFAULT '',
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_project_path
      ON sessions (project_path);

    -- ──────────────────────────────────────────
    -- runs: every MCP tool invocation
    -- ──────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS runs (
      id            TEXT PRIMARY KEY,
      tool_name     TEXT NOT NULL,
      project_path  TEXT,
      started_at    TEXT NOT NULL,
      completed_at  TEXT,
      status        TEXT NOT NULL DEFAULT 'in-progress'
                      CHECK(status IN ('ok','error','in-progress')),
      error_code    TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_runs_project_path
      ON runs (project_path);

    CREATE INDEX IF NOT EXISTS idx_runs_started_at
      ON runs (started_at);

    -- ──────────────────────────────────────────
    -- test_results: per-test outcomes
    -- ──────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS test_results (
      id            TEXT PRIMARY KEY,
      run_id        TEXT NOT NULL REFERENCES runs(id),
      test_id       TEXT NOT NULL,
      test_name     TEXT NOT NULL,
      test_file     TEXT NOT NULL,
      test_type     TEXT NOT NULL CHECK(test_type IN ('frontend-e2e','backend-integration')),
      status        TEXT NOT NULL CHECK(status IN ('passed','failed','skipped')),
      error_message TEXT,
      duration_ms   INTEGER,
      created_at    TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_test_results_run_id
      ON test_results (run_id);

    CREATE INDEX IF NOT EXISTS idx_test_results_test_id
      ON test_results (test_id);

    -- ──────────────────────────────────────────
    -- code_summaries: cached project analysis
    -- ──────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS code_summaries (
      id            TEXT PRIMARY KEY,
      project_path  TEXT NOT NULL UNIQUE,
      framework     TEXT NOT NULL DEFAULT '',
      summary_json  TEXT NOT NULL DEFAULT '{}',
      created_at    TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_code_summaries_project_path
      ON code_summaries (project_path);
  `);
}
