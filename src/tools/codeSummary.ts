/**
 * Tool 2: localsprite_generate_code_summary
 *
 * Scans the project, identifies framework and key files, delegates heavy analysis
 * to cc subprocess with planModel. Writes code_summary.json.
 */
import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition, ToolResult, ServerContext } from '../types/mcp.js';

export const codeSummaryInputSchema = z.object({
  projectRootPath: z.string(),
});

type CodeSummaryInput = z.infer<typeof codeSummaryInputSchema>;

export interface CodeSummaryOutput {
  status: 'ok';
  outputPath: string;
  framework: string;
  entryPoints: string[];
  featureAreas: { name: string; files: string[] }[];
  dependencies: { name: string; version: string }[];
  testingSetup: string;
}

function collectCandidateFiles(projectRootPath: string): string[] {
  const candidates: string[] = [];

  // Always include package.json and README.md
  for (const f of ['package.json', 'README.md', 'README.md'.toLowerCase()]) {
    const fp = path.join(projectRootPath, f);
    if (fs.existsSync(fp)) candidates.push(fp);
  }

  // Top-level TS/JS/TSX/JSX
  try {
    const entries = fs.readdirSync(projectRootPath);
    for (const e of entries) {
      if (/\.(ts|js|tsx|jsx)$/.test(e)) {
        candidates.push(path.join(projectRootPath, e));
      }
    }
  } catch {
    // ignore
  }

  // src/**/*.ts (max 50 by size, largest first)
  const srcDir = path.join(projectRootPath, 'src');
  if (fs.existsSync(srcDir)) {
    const srcFiles: { fp: string; size: number }[] = [];
    function walk(dir: string): void {
      try {
        for (const e of fs.readdirSync(dir)) {
          const fp = path.join(dir, e);
          const stat = fs.statSync(fp);
          if (stat.isDirectory()) walk(fp);
          else if (/\.(ts|tsx)$/.test(e)) srcFiles.push({ fp, size: stat.size });
        }
      } catch {
        // ignore
      }
    }
    walk(srcDir);
    srcFiles.sort((a, b) => b.size - a.size);
    candidates.push(...srcFiles.slice(0, 50).map((f) => f.fp));
  }

  // Deduplicate
  return [...new Set(candidates)];
}

function buildPrompt(projectRootPath: string, files: string[]): string {
  const snippets: string[] = [];
  for (const fp of files) {
    try {
      const content = fs.readFileSync(fp, 'utf-8').slice(0, 4000);
      snippets.push(`=== ${path.relative(projectRootPath, fp)} ===\n${content}`);
    } catch {
      // skip unreadable
    }
  }

  return `You are a code analysis assistant. Analyze the following project files and return a JSON object with this exact schema:
{
  "framework": "<string, e.g. react, express, next, fastify, vue, svelte, node>",
  "entryPoints": ["<relative file path>", ...],
  "featureAreas": [{ "name": "<string>", "files": ["<relative path>", ...] }, ...],
  "dependencies": [{ "name": "<package name>", "version": "<version string>" }, ...],
  "testingSetup": "<vitest|jest|mocha|none|unknown>"
}

Return ONLY valid JSON, no markdown, no explanation.

Project files:
${snippets.join('\n\n')}`;
}

export async function runCodeSummary(
  projectRootPath: string,
  ctx: ServerContext,
): Promise<CodeSummaryOutput> {
  if (!fs.existsSync(projectRootPath)) {
    throw new McpError(
      ErrorCode.InternalError,
      'ERR_PROJECT_NOT_FOUND',
      {
        code: 'ERR_PROJECT_NOT_FOUND',
        projectRootPath,
        suggestion: 'Verify the path exists and is a Node.js project root.',
      },
    );
  }
  if (!fs.existsSync(path.join(projectRootPath, 'package.json'))) {
    throw new McpError(
      ErrorCode.InternalError,
      'ERR_NOT_NODE_PROJECT',
      {
        code: 'ERR_NOT_NODE_PROJECT',
        projectRootPath,
        suggestion: 'MVP-0 supports Node.js projects only. Add a package.json to the project root.',
      },
    );
  }

  const files = collectCandidateFiles(projectRootPath);
  const prompt = buildPrompt(projectRootPath, files);

  let parsed: Record<string, unknown> | null = null;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    let ccResult;
    try {
      ccResult = await ctx.ccClient.run({
        model: 'haiku',
        prompt,
        timeoutMs: 60_000,
      });
    } catch (err) {
      throw new McpError(
        ErrorCode.InternalError,
        'ERR_CC_FAILED',
        { code: 'ERR_CC_FAILED', suggestion: 'Check that the claude CLI is installed and authenticated.' },
      );
    }

    try {
      // Strip markdown fences if present
      const raw = ccResult.stdout.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '');
      parsed = JSON.parse(raw) as Record<string, unknown>;
      break;
    } catch (err) {
      lastErr = err;
    }
  }

  if (!parsed) {
    throw new McpError(
      ErrorCode.InternalError,
      'ERR_CC_OUTPUT_INVALID',
      { code: 'ERR_CC_OUTPUT_INVALID', suggestion: 'Retry; if persistent, file a bug.', cause: String(lastErr) },
    );
  }

  const outputDir = path.join(projectRootPath, '.localsprite');
  try {
    fs.mkdirSync(outputDir, { recursive: true });
  } catch (err) {
    throw new McpError(
      ErrorCode.InternalError,
      'ERR_WRITE_FAILED',
      { code: 'ERR_WRITE_FAILED', suggestion: 'Check filesystem permissions for the .localsprite directory.', cause: String(err) },
    );
  }

  const outputPath = path.join(outputDir, 'code_summary.json');
  const framework = typeof parsed.framework === 'string' && parsed.framework ? parsed.framework : 'unknown';
  const entryPoints = Array.isArray(parsed.entryPoints) ? (parsed.entryPoints as string[]) : [];
  const featureAreas = Array.isArray(parsed.featureAreas)
    ? (parsed.featureAreas as { name: string; files: string[] }[])
    : [];
  const dependencies = Array.isArray(parsed.dependencies)
    ? (parsed.dependencies as { name: string; version: string }[])
    : [];
  const testingSetup = typeof parsed.testingSetup === 'string' ? parsed.testingSetup : 'unknown';

  const summary = { framework, entryPoints, featureAreas, dependencies, testingSetup };

  try {
    fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2), 'utf-8');
  } catch (err) {
    throw new McpError(
      ErrorCode.InternalError,
      'ERR_WRITE_FAILED',
      { code: 'ERR_WRITE_FAILED', suggestion: 'Check filesystem permissions for the .localsprite directory.', cause: String(err) },
    );
  }

  return {
    status: 'ok',
    outputPath,
    framework,
    entryPoints,
    featureAreas,
    dependencies,
    testingSetup,
  };
}

async function codeSummaryHandler(args: unknown, ctx: ServerContext): Promise<ToolResult> {
  const input = args as CodeSummaryInput;
  const startedAt = new Date().toISOString();
  const paramsHash = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');

  let runId: number | bigint = 0;
  try {
    const insert = ctx.db.prepare(
      `INSERT INTO runs (tool, params_hash, started_at) VALUES (?, ?, ?)`,
    );
    const result = insert.run('localsprite_generate_code_summary', paramsHash, startedAt);
    runId = result.lastInsertRowid;
  } catch (err) {
    ctx.logger.warn('Failed to insert run row', { err });
  }

  let outcome = 'ok';
  let errorCode: string | null = null;

  try {
    const output = await runCodeSummary(input.projectRootPath, ctx);

    const endedAt = new Date().toISOString();
    const durationMs = new Date(endedAt).getTime() - new Date(startedAt).getTime();
    try {
      ctx.db.prepare(`UPDATE runs SET outcome = ?, ended_at = ?, duration_ms = ? WHERE id = ?`)
        .run(outcome, endedAt, durationMs, runId);
    } catch { /* ignore */ }

    return { content: [{ type: 'text', text: JSON.stringify(output) }] };
  } catch (err) {
    outcome = 'error';
    if (err instanceof McpError) {
      const data = err.data as { code?: string } | undefined;
      errorCode = data?.code ?? null;
    }
    const endedAt = new Date().toISOString();
    const durationMs = new Date(endedAt).getTime() - new Date(startedAt).getTime();
    try {
      ctx.db.prepare(`UPDATE runs SET outcome = ?, ended_at = ?, duration_ms = ?, error_code = ? WHERE id = ?`)
        .run(outcome, endedAt, durationMs, errorCode, runId);
    } catch { /* ignore */ }
    throw err;
  }
}

export const codeSummaryTool: ToolDefinition = {
  name: 'localsprite_generate_code_summary',
  description:
    'Scans the project, identifies framework and key files, and generates a structured code summary using cc subprocess. Writes code_summary.json.',
  inputSchema: codeSummaryInputSchema,
  handler: codeSummaryHandler,
};
