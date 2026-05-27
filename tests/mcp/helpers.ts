/**
 * Test helpers for MCP server tests.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { Db, Stmt, CcClient, Logger, DockerManager, BrowserPool, DockerContainer } from '../../src/mcp/_deps.js';
import type { ServerContext, ResolvedConfig } from '../../src/types/mcp.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

// ─── Temp project factory ─────────────────────────────────────────────────────

export interface TestProject {
  projectPath: string;
  cleanup: () => void;
}

export interface CreateTestProjectOptions {
  noPackageJson?: boolean;
  packageJson?: Record<string, unknown>;
  files?: Record<string, string>;
}

export function createTestProject(opts: CreateTestProjectOptions = {}): TestProject {
  const tmpDir = path.join(os.tmpdir(), `tspr-test-${crypto.randomUUID()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  if (!opts.noPackageJson) {
    const pkgJson = opts.packageJson ?? { name: 'test-project', version: '1.0.0' };
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify(pkgJson, null, 2), 'utf-8');
  }

  if (opts.files) {
    for (const [relPath, content] of Object.entries(opts.files)) {
      const absPath = path.join(tmpDir, relPath);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, content, 'utf-8');
    }
  }

  return {
    projectPath: tmpDir,
    cleanup: () => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch { /* ignore */ }
    },
  };
}

// ─── Mock DB ──────────────────────────────────────────────────────────────────

export interface MockDb extends Db {
  /** All rows stored per table name. Mutated on every INSERT/UPDATE. */
  _tables: Map<string, Array<Record<string, unknown>>>;
  /** Expose rows for a given table (for test assertions). */
  getRows(table: string): Array<Record<string, unknown>>;
}

/**
 * A lightweight in-memory mock DB that:
 *  - Parses INSERT column lists and stores named rows.
 *  - Returns the latest matching row for SELECT … WHERE project_path = ?
 *    and SELECT … WHERE id = ?.
 *  - Applies UPDATE status/completed_at by id.
 *
 * This is intentionally minimal — it covers exactly the SQL shapes used by
 * bootstrap.ts and frontendPlan.ts.
 */
export function makeMockDb(): MockDb {
  const tables = new Map<string, Array<Record<string, unknown>>>();
  let autoId = 0;

  function getTable(name: string): Array<Record<string, unknown>> {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name)!;
  }

  /** Parse "INSERT INTO <table> (col1, col2, ...) VALUES (?, ?, ...)" */
  function handleInsert(sql: string, args: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    const m = /INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)/i.exec(sql);
    if (m) {
      const tableName = m[1];
      const cols = m[2].split(',').map((c) => c.trim());
      const row: Record<string, unknown> = {};
      for (let i = 0; i < cols.length; i++) {
        row[cols[i]] = args[i];
      }
      getTable(tableName).push(row);
    }
    autoId++;
    return { changes: 1, lastInsertRowid: autoId };
  }

  /** Parse simple UPDATE … SET col=? WHERE id=? */
  function handleUpdate(sql: string, args: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    const tableM = /UPDATE\s+(\w+)\s+SET\s+(.+?)\s+WHERE\s+id\s*=\s*\?/i.exec(sql);
    if (tableM) {
      const tableName = tableM[1];
      const setPart = tableM[2];
      const setCols = setPart.split(',').map((s) => s.trim().replace(/\s*=\s*\?$/, '').trim());
      const idArg = args[setCols.length]; // id is the last ?
      const rows = getTable(tableName);
      for (const row of rows) {
        if (row['id'] === idArg) {
          for (let i = 0; i < setCols.length; i++) {
            row[setCols[i]] = args[i];
          }
        }
      }
    }
    return { changes: 1, lastInsertRowid: 0 };
  }

  /** SELECT … FROM <table> WHERE project_path = ? ORDER BY created_at DESC LIMIT 1 */
  function handleSelect(sql: string, args: unknown[]): unknown {
    const tableM = /FROM\s+(\w+)/i.exec(sql);
    if (!tableM) return undefined;
    const tableName = tableM[1];
    const rows = getTable(tableName);

    // Filter by project_path if present in WHERE
    const filterByPath = /WHERE\s+project_path\s*=\s*\?/i.test(sql);
    const filterById = /WHERE\s+id\s*=\s*\?/i.test(sql);

    let filtered = rows;
    if (filterByPath && args[0] !== undefined) {
      filtered = rows.filter((r) => r['project_path'] === args[0]);
    } else if (filterById && args[0] !== undefined) {
      filtered = rows.filter((r) => r['id'] === args[0]);
    }

    // Sort by created_at desc (string ISO sort works correctly)
    filtered = [...filtered].sort((a, b) => {
      const ta = String(a['created_at'] ?? '');
      const tb = String(b['created_at'] ?? '');
      return tb.localeCompare(ta);
    });

    const isAll = /\.all\b/.test(sql); // heuristic — not needed; callers use .get()/.all()
    return filtered[0];
  }

  function makeStmt(sql: string): Stmt {
    const isInsert = /^\s*INSERT/i.test(sql);
    const isUpdate = /^\s*UPDATE/i.test(sql);

    return {
      run(...args: unknown[]) {
        if (isInsert) return handleInsert(sql, args);
        if (isUpdate) return handleUpdate(sql, args);
        return { changes: 0, lastInsertRowid: 0 };
      },
      get(...args: unknown[]) {
        return handleSelect(sql, args);
      },
      all(...args: unknown[]) {
        const tableM = /FROM\s+(\w+)/i.exec(sql);
        if (!tableM) return [];
        const tableName = tableM[1];
        const rows = getTable(tableName);
        const filterByPath = /WHERE\s+project_path\s*=\s*\?/i.test(sql);
        if (filterByPath && args[0] !== undefined) {
          return rows.filter((r) => r['project_path'] === args[0]);
        }
        return rows;
      },
    };
  }

  return {
    _tables: tables,
    getRows(table: string) {
      return getTable(table);
    },
    exec(_sql: string) { /* no-op — schema is implicit */ },
    prepare(sql: string) {
      return makeStmt(sql);
    },
    close() { /* no-op */ },
  };
}

// ─── Mock CcClient ────────────────────────────────────────────────────────────

export function makeMockCcClient(response: string | (() => string)): CcClient {
  return {
    async run(_opts) {
      const stdout = typeof response === 'function' ? response() : response;
      return { stdout, costUsd: 0 };
    },
  };
}

export function makeFailingCcClient(): CcClient {
  return {
    async run(_opts) {
      throw new Error('cc subprocess failed with exit code 1');
    },
  };
}

// ─── Mock Logger ──────────────────────────────────────────────────────────────

export function makeMockLogger(): Logger {
  return {
    info: (_msg, _ctx) => {},
    warn: (_msg, _ctx) => {},
    error: (_msg, _ctx) => {},
    debug: (_msg, _ctx) => {},
  };
}

// ─── Mock Docker ──────────────────────────────────────────────────────────────

export interface MockDockerManager extends DockerManager {
  _pingFails: boolean;
  _containers: DockerContainer[];
}

export function makeMockDockerManager(pingFails = false): MockDockerManager {
  const containers: DockerContainer[] = [];

  return {
    _pingFails: pingFails,
    _containers: containers,
    async ping() {
      if (pingFails) throw new Error('Docker daemon not reachable');
    },
    async createContainer(opts) {
      const container: DockerContainer = {
        id: `mock-container-${crypto.randomUUID()}`,
        async stop() {},
        async remove() {
          const idx = containers.indexOf(container);
          if (idx >= 0) containers.splice(idx, 1);
        },
      };
      containers.push(container);
      return container;
    },
    async teardownAll() {
      containers.length = 0;
    },
  };
}

// ─── Mock BrowserPool ─────────────────────────────────────────────────────────

export function makeMockBrowserPool(): BrowserPool {
  return {
    async destroyAll() {},
  };
}

// ─── Default ResolvedConfig ───────────────────────────────────────────────────

export function makeDefaultConfig(overrides?: Partial<ResolvedConfig>): ResolvedConfig {
  return {
    model: 'claude-sonnet-4-5',
    planModel: 'claude-haiku-4-5',
    concurrency: 1,
    logLevel: 'info',
    configPath: path.join(os.homedir(), '.tspr', 'config.json'),
    dockerImage: 'node:24-alpine',
    browserPoolSize: 3,
    executeTimeoutMs: 300_000,
    ...overrides,
  };
}

// ─── ServerContext factory ────────────────────────────────────────────────────

export function makeContext(overrides?: Partial<ServerContext>): ServerContext {
  return {
    config: makeDefaultConfig(),
    db: makeMockDb(),
    ccClient: makeMockCcClient('{}'),
    docker: makeMockDockerManager(),
    browserPool: makeMockBrowserPool(),
    logger: makeMockLogger(),
    ...overrides,
  };
}

// ─── Extract error data from McpError ─────────────────────────────────────────

export function getMcpErrorData(err: unknown): { code: string; suggestion: string } | null {
  if (err instanceof McpError) {
    return err.data as { code: string; suggestion: string } | null;
  }
  return null;
}

export function getMcpErrorCode(err: unknown): number | null {
  if (err instanceof McpError) {
    return err.code;
  }
  return null;
}
