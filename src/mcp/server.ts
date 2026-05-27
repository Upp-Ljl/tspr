/**
 * MCP Server bootstrap, transport, dispatch.
 *
 * Parses CLI flags, loads config, initializes SQLite, registers tool handlers,
 * connects stdio transport.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  McpError,
  ErrorCode,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { Mutex } from 'async-mutex';
import { zodToJsonSchema } from 'zod-to-json-schema';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import Database from 'better-sqlite3';

import { TOOL_DEFINITIONS, TOOL_MAP } from './registry.js';
import type { ServerContext, ResolvedConfig } from '../types/mcp.js';
import type { CcClient, Db, Logger, BrowserPool } from './_deps.js';
import { createCcClient } from '../lib/cc.js';
import { loadConfig } from '../lib/config.js';

// ─── Package version ────────────────────────────────────────────────────────
// Resolved at build time via package.json
let PKG_VERSION = '0.0.0';
try {
  const pkgPath = new URL('../../package.json', import.meta.url);
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version: string };
  PKG_VERSION = pkg.version;
} catch { /* ignore */ }

// ─── CLI flag parsing ────────────────────────────────────────────────────────
function parseArgs(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  const knownFlags = new Set(['--model', '--plan-model', '--concurrency', '--log-level', '--config', '--provider']);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        flags[arg] = 'true';
      } else {
        flags[arg] = value;
        i++;
      }
      if (!knownFlags.has(arg)) {
        process.stderr.write(`[tspr] warn: unknown flag ${arg}\n`);
      }
    }
  }
  return flags;
}

// ─── Config file ─────────────────────────────────────────────────────────────
interface ConfigFile {
  model?: string;
  planModel?: string;
  dockerImage?: string;
  browserPoolSize?: number;
  executeTimeoutMs?: number;
  logLevel?: string;
}

function loadConfigFile(configPath: string): ConfigFile {
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(raw) as ConfigFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(`[tspr] warn: config file not parseable JSON, using defaults\n`);
    }
    return {};
  }
}

function buildConfig(flags: Record<string, string>): ResolvedConfig & { provider?: string } {
  const configPath = flags['--config'] ?? path.join(os.homedir(), '.tspr', 'config.json');
  const fileConfig = loadConfigFile(configPath);

  // Also load provider config (shared path, tolerates missing file)
  let providerFileConfig: { provider?: string } = {};
  try {
    providerFileConfig = loadConfig(configPath);
  } catch { /* tolerate — falls back to defaults */ }

  const logLevel = (flags['--log-level'] ?? fileConfig.logLevel ?? 'info') as ResolvedConfig['logLevel'];
  const concurrency = parseInt(flags['--concurrency'] ?? '1', 10);
  if (concurrency > 1) {
    throw new Error('--concurrency > 1 is not supported in MVP-0');
  }

  return {
    model: flags['--model'] ?? fileConfig.model ?? 'claude-sonnet-4-5',
    planModel: flags['--plan-model'] ?? fileConfig.planModel ?? 'claude-haiku-4-5',
    concurrency,
    logLevel,
    configPath,
    dockerImage: fileConfig.dockerImage ?? 'node:24-alpine',
    browserPoolSize: fileConfig.browserPoolSize ?? 3,
    executeTimeoutMs: fileConfig.executeTimeoutMs ?? 300_000,
    provider: flags['--provider'] ?? providerFileConfig.provider,
  };
}

// ─── Logger factory ───────────────────────────────────────────────────────────
function makeLogger(logLevel: string): Logger {
  const levels = ['debug', 'info', 'warn', 'error'];
  const minLevel = levels.indexOf(logLevel);

  function log(level: string, msg: string, ctx?: object): void {
    if (levels.indexOf(level) >= minLevel) {
      const line = ctx
        ? `[tspr] ${level}: ${msg} ${JSON.stringify(ctx)}`
        : `[tspr] ${level}: ${msg}`;
      process.stderr.write(line + '\n');
    }
  }

  return {
    info: (msg, ctx) => log('info', msg, ctx),
    warn: (msg, ctx) => log('warn', msg, ctx),
    error: (msg, ctx) => log('error', msg, ctx),
    debug: (msg, ctx) => log('debug', msg, ctx),
  };
}

// ─── SQLite initialization ────────────────────────────────────────────────────
function initDb(logger: Logger): Db {
  const dbDir = path.join(os.homedir(), '.tspr');
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'db.sqlite');

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  // Apply migrations idempotently
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT,
      tool        TEXT NOT NULL,
      params_hash TEXT NOT NULL,
      started_at  TEXT NOT NULL,
      ended_at    TEXT,
      outcome     TEXT,
      error_code  TEXT,
      duration_ms INTEGER
    );

    CREATE TABLE IF NOT EXISTS test_results (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id   INTEGER,
      test_id  TEXT NOT NULL,
      title    TEXT,
      outcome  TEXT,
      stack    TEXT
    );

    CREATE TABLE IF NOT EXISTS code_summaries (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path    TEXT NOT NULL,
      framework       TEXT,
      summary_json    TEXT,
      created_at      TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id                 TEXT PRIMARY KEY,
      project_path       TEXT NOT NULL,
      local_port         INTEGER NOT NULL DEFAULT 5173,
      type               TEXT NOT NULL CHECK(type IN ('frontend','backend')),
      test_scope         TEXT NOT NULL CHECK(test_scope IN ('codebase','diff')),
      detected_framework TEXT NOT NULL DEFAULT '',
      created_at         TEXT NOT NULL,
      updated_at         TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_project_path
      ON sessions (project_path);
  `);

  logger.info('SQLite initialized', { path: dbPath });

  return db as unknown as Db;
}

// ─── Stub implementations (replaced by lib-impl in Round 5) ─────────────────

function makeCcClient(config: ResolvedConfig & { provider?: string }, logger: Logger): CcClient {
  // Load full provider config from the config file path
  let localSpriteConfig = {};
  try {
    localSpriteConfig = loadConfig(config.configPath);
  } catch (err) {
    logger.warn('Could not load tspr provider config, falling back to claude subprocess', {
      err: String(err),
    });
  }

  const providerOverride = config.provider as 'claude' | 'openai-compat' | 'minimax' | undefined;
  const mergedConfig = { ...localSpriteConfig, ...(providerOverride ? { provider: providerOverride } : {}) };

  return createCcClient(mergedConfig);
}

function makeBrowserPool(): BrowserPool {
  return {
    async destroyAll() {
      // Placeholder; real impl in Round 5
    },
  };
}

// ─── Global state ──────────────────────────────────────────────────────────
const callToolMutex = new Mutex();
let shuttingDown = false;
let serverContext: ServerContext | null = null;

// ─── Main bootstrap ───────────────────────────────────────────────────────────
export async function startMcpServer(argv: string[] = process.argv.slice(2)): Promise<void> {
  const flags = parseArgs(argv);
  const config = buildConfig(flags);
  const logger = makeLogger(config.logLevel);

  let db: Db;
  try {
    db = initDb(logger);
  } catch (err) {
    process.stderr.write(`[tspr] fatal: SQLite init failed: ${String(err)}\n`);
    process.exit(1);
  }

  const ccClient = makeCcClient(config, logger);
  const browserPool = makeBrowserPool();

  // docker is omitted from serverContext — production sandbox uses createSandbox() directly.
  // Sandbox registry handles its own SIGINT/SIGTERM cleanup.
  serverContext = { config, db, ccClient, browserPool, logger };

  const server = new Server(
    { name: 'tspr', version: PKG_VERSION },
    { capabilities: { tools: {} } },
  );

  // ListTools handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: TOOL_DEFINITIONS.map((td) => ({
        name: td.name,
        description: td.description,
        inputSchema: zodToJsonSchema(td.inputSchema),
      })),
    };
  });

  // CallTool handler
  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    if (shuttingDown) {
      throw new McpError(
        ErrorCode.InternalError,
        'ERR_SERVER_SHUTTING_DOWN',
        {
          code: 'ERR_SERVER_SHUTTING_DOWN',
          suggestion: 'Restart the server and retry.',
        },
      );
    }

    const td = TOOL_MAP.get(req.params.name);
    if (!td) {
      throw new McpError(
        ErrorCode.MethodNotFound,
        `Unknown tool: ${req.params.name}`,
        {
          code: `Unknown tool: ${req.params.name}`,
          suggestion: `Available tools: ${[...TOOL_MAP.keys()].join(', ')}`,
        },
      );
    }

    return await callToolMutex.runExclusive(async () => {
      const parsed = td.inputSchema.safeParse(req.params.arguments);
      if (!parsed.success) {
        throw new McpError(
          ErrorCode.InvalidParams,
          parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          {
            code: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
            suggestion: 'Check the tool input schema and provide all required parameters with correct types.',
            issues: parsed.error.issues,
          },
        );
      }

      const ctx = serverContext!;
      return await td.handler(parsed.data, ctx);
    });
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(
    `[tspr] MCP server started (v${PKG_VERSION}, model=${config.model}, pid=${process.pid})\n`,
  );

  // Graceful shutdown handlers
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down...`);

    // Wait up to 10 s for in-flight call
    const gracePeriodMs = 10_000;
    const deadline = Date.now() + gracePeriodMs;
    while (callToolMutex.isLocked() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }

    try {
      await browserPool.destroyAll();
    } catch { /* ignore */ }
    try {
      db.close();
    } catch { /* ignore */ }

    process.exit(0);
  }

  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });

  process.on('uncaughtException', (err) => {
    process.stderr.write(`[tspr] uncaughtException: ${String(err)}\n`);
    process.exit(1);
  });
}
