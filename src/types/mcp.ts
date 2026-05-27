/**
 * Core MCP module types.
 */
import type { z } from 'zod';
import type { CcClient, Db, Logger, DockerManager, BrowserPool } from '../mcp/_deps.js';

export interface ToolResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

export interface ResolvedConfig {
  model: string;
  planModel: string;
  concurrency: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  configPath: string;
  dockerImage: string;
  browserPoolSize: number;
  executeTimeoutMs: number;
}

export interface ServerContext {
  config: ResolvedConfig;
  db: Db;
  ccClient: CcClient;
  /** Optional: present in tests for mock-based ping checks; absent in production (sandbox handles Docker directly). */
  docker?: DockerManager;
  browserPool: BrowserPool;
  logger: Logger;
}

export interface ToolDefinition {
  name: string;
  description: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputSchema: z.ZodObject<any>;
  handler: (args: unknown, ctx: ServerContext) => Promise<ToolResult>;
}
