/**
 * Tool 1: tspr_bootstrap_tests
 *
 * Session entry point. Validates project path, detects project type,
 * checks Docker, writes session record to SQLite.
 */
import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition, ToolResult, ServerContext } from '../types/mcp.js';

export const bootstrapInputSchema = z.object({
  localPort: z.number().int().min(1, 'ERR_INVALID_PORT').max(65535, 'ERR_INVALID_PORT').default(5173),
  path: z.string().optional(),
  type: z.enum(['frontend', 'backend']),
  projectPath: z.string(),
  testScope: z.enum(['codebase', 'diff']),
});

type BootstrapInput = z.infer<typeof bootstrapInputSchema>;

function detectFramework(projectPath: string, type: string): { projectType: string; framework: string } {
  let pkgJson: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(path.join(projectPath, 'package.json'), 'utf-8');
    pkgJson = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // ignore
  }

  const deps: Record<string, string> = {
    ...((pkgJson.dependencies as Record<string, string>) || {}),
    ...((pkgJson.devDependencies as Record<string, string>) || {}),
  };

  const hasFrontend = deps['react'] || deps['vue'] || deps['svelte'] || deps['next'];
  const hasBackend = deps['express'] || deps['fastify'] || deps['next'] || deps['koa'];

  let projectType: string;
  if (hasFrontend && hasBackend) {
    projectType = 'fullstack';
  } else if (type === 'frontend' || hasFrontend) {
    projectType = 'frontend';
  } else {
    projectType = 'backend';
  }

  let framework = 'unknown';
  if (deps['next']) framework = 'next';
  else if (deps['react'] && deps['express']) framework = 'react+express';
  else if (deps['react']) framework = 'react';
  else if (deps['vue']) framework = 'vue';
  else if (deps['svelte']) framework = 'svelte';
  else if (deps['fastify']) framework = 'fastify';
  else if (deps['express']) framework = 'express';
  else if (deps['koa']) framework = 'koa';
  else framework = type === 'frontend' ? 'static' : 'node';

  return { projectType, framework };
}

async function bootstrapHandler(args: unknown, ctx: ServerContext): Promise<ToolResult> {
  const input = args as BootstrapInput;
  const { projectPath, type } = input;

  // Validate project path exists
  if (!fs.existsSync(projectPath)) {
    throw new McpError(
      ErrorCode.InternalError,
      'ERR_PROJECT_NOT_FOUND',
      {
        code: 'ERR_PROJECT_NOT_FOUND',
        projectPath,
        suggestion: 'Verify the path exists and is a Node.js project root.',
      },
    );
  }

  // Validate package.json
  if (!fs.existsSync(path.join(projectPath, 'package.json'))) {
    throw new McpError(
      ErrorCode.InternalError,
      'ERR_NOT_NODE_PROJECT',
      {
        code: 'ERR_NOT_NODE_PROJECT',
        projectPath,
        suggestion: 'MVP-0 supports Node.js projects only. Add a package.json to the project root.',
      },
    );
  }

  // Check Docker daemon (only when DockerManager is injected; production relies on sandbox internals)
  if (ctx.docker) {
    try {
      await ctx.docker.ping();
    } catch {
      throw new McpError(
        ErrorCode.InternalError,
        'ERR_DOCKER_UNAVAILABLE',
        {
          code: 'ERR_DOCKER_UNAVAILABLE',
          suggestion: 'Start Docker Desktop or install Docker and ensure the daemon is running.',
        },
      );
    }
  }

  const sessionId = crypto.randomUUID();
  const { projectType, framework } = detectFramework(projectPath, type);
  const warnings: string[] = [];

  const createdAt = new Date().toISOString();

  // Persist session row so downstream tools (frontendPlan, backendPlan, rerunTests)
  // can look it up by projectPath via the sessions table.
  try {
    ctx.db.prepare(
      `INSERT INTO sessions (id, project_path, local_port, type, test_scope, detected_framework, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sessionId,
      projectPath,
      input.localPort,
      type,
      input.testScope,
      framework,
      createdAt,
      createdAt,
    );
  } catch (err) {
    ctx.logger.warn('Failed to insert sessions row', { err });
  }

  // Record this invocation in the runs audit table.
  const startedAt = createdAt;
  const runId = crypto.randomUUID();
  try {
    ctx.db.prepare(
      `INSERT INTO runs (id, tool_name, project_path, started_at, completed_at, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(runId, 'tspr_bootstrap_tests', projectPath, startedAt, startedAt, 'ok');
  } catch (err) {
    ctx.logger.warn('Failed to insert runs row', { err });
  }

  const output = {
    status: 'ok',
    sessionId,
    projectType,
    detectedFramework: framework,
    nextAction: `Project detected as ${projectType} (${framework}). Call tspr_generate_code_summary next.`,
    warnings,
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(output) }],
  };
}

export const bootstrapTool: ToolDefinition = {
  name: 'tspr_bootstrap_tests',
  description:
    'Session entry point. Validates the project path, detects project type, checks Docker, and writes a session record. Returns next-action instructions.',
  inputSchema: bootstrapInputSchema,
  handler: bootstrapHandler,
};
