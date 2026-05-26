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
  _rows: Map<string, unknown[]>;
  _lastId: number;
}

export function makeMockDb(): MockDb {
  const tables = new Map<string, unknown[]>();
  let lastId = 0;

  function makeStmt(sql: string): Stmt {
    const isInsert = /^\s*INSERT/i.test(sql);
    const isUpdate = /^\s*UPDATE/i.test(sql);
    const isSelect = /^\s*SELECT/i.test(sql);

    return {
      run(..._args: unknown[]) {
        lastId++;
        return { changes: 1, lastInsertRowid: lastId };
      },
      get(..._args: unknown[]) {
        // Return the first row from 'runs' table
        const runsTable = tables.get('runs') as Array<Record<string, unknown>> | undefined;
        if (isSelect && runsTable && runsTable.length > 0) {
          return runsTable[0];
        }
        return undefined;
      },
      all(..._args: unknown[]) {
        const runsTable = tables.get('runs') as unknown[] | undefined;
        return runsTable ?? [];
      },
    };
  }

  return {
    _rows: tables,
    _lastId: lastId,
    exec(_sql: string) { /* no-op */ },
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
