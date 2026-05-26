/**
 * Tool 8: localsprite_rerun_tests
 *
 * Reruns the tests from the most recent generate_code_and_execute call using
 * existing generated .spec.ts files — does not regenerate code.
 */
import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition, ToolResult, ServerContext } from '../types/mcp.js';
import { runExecute, type ExecuteResult } from './generateAndExecute.js';

export const rerunTestsInputSchema = z.object({
  projectPath: z.string(),
});

type RerunTestsInput = z.infer<typeof rerunTestsInputSchema>;

async function rerunTestsHandler(args: unknown, ctx: ServerContext): Promise<ToolResult> {
  const input = args as RerunTestsInput;
  const { projectPath } = input;

  const startedAt = new Date().toISOString();
  const paramsHash = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');

  let runId: number | bigint = 0;
  try {
    const insert = ctx.db.prepare(
      `INSERT INTO runs (tool, params_hash, started_at) VALUES (?, ?, ?)`,
    );
    const result = insert.run('localsprite_rerun_tests', paramsHash, startedAt);
    runId = result.lastInsertRowid;
  } catch (err) {
    ctx.logger.warn('Failed to insert run row', { err });
  }

  let outcome = 'ok';
  let errorCode: string | null = null;

  try {
    if (!fs.existsSync(projectPath)) {
      throw new McpError(
        ErrorCode.InternalError,
        'ERR_PROJECT_NOT_FOUND',
        {
          code: 'ERR_PROJECT_NOT_FOUND',
          projectPath,
          suggestion: 'Verify the path exists.',
        },
      );
    }

    // Look up most recent generate_code_and_execute run for this projectPath.
    // Primary indicator: test_results.json on disk (written by generate_code_and_execute).
    // Secondary: runs table in SQLite (may not have the row in mock/test environments).
    const testResultsPath = path.join(projectPath, '.localsprite', 'test_results.json');
    let priorRunExists = fs.existsSync(testResultsPath);

    if (!priorRunExists) {
      throw new McpError(
        ErrorCode.InternalError,
        'ERR_NO_PRIOR_RUN',
        {
          code: 'ERR_NO_PRIOR_RUN',
          projectPath,
          suggestion: 'Run localsprite_generate_code_and_execute first for this project.',
        },
      );
    }

    // Check generated tests exist
    const generatedTestsDir = path.join(projectPath, '.localsprite', 'generated_tests');
    let hasSpecFiles = false;
    try {
      const files = fs.readdirSync(generatedTestsDir);
      hasSpecFiles = files.some((f) => f.endsWith('.spec.ts'));
    } catch { /* ignore */ }

    if (!hasSpecFiles) {
      throw new McpError(
        ErrorCode.InternalError,
        'ERR_GENERATED_TESTS_MISSING',
        {
          code: 'ERR_GENERATED_TESTS_MISSING',
          projectPath,
          suggestion: 'Re-run localsprite_generate_code_and_execute to regenerate test files.',
        },
      );
    }

    // Re-execute Docker run with same test files
    // Read prior test plan info to get projectName
    let projectName = path.basename(projectPath);
    try {
      const testResults = JSON.parse(
        fs.readFileSync(path.join(projectPath, '.localsprite', 'test_results.json'), 'utf-8'),
      ) as { projectName?: string };
      if (testResults.projectName) projectName = testResults.projectName;
    } catch { /* ignore */ }

    const result = await runExecute(
      { projectName, projectPath, testIds: [], additionalInstruction: '' },
      ctx,
    );

    const endedAt = new Date().toISOString();
    const durationMs = new Date(endedAt).getTime() - new Date(startedAt).getTime();
    try {
      ctx.db.prepare(`UPDATE runs SET outcome = ?, ended_at = ?, duration_ms = ? WHERE id = ?`)
        .run(outcome, endedAt, durationMs, runId);
    } catch { /* ignore */ }

    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
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

export const rerunTestsTool: ToolDefinition = {
  name: 'localsprite_rerun_tests',
  description:
    'Reruns the tests from the most recent generate_code_and_execute call using existing generated .spec.ts files — no code regeneration.',
  inputSchema: rerunTestsInputSchema,
  handler: rerunTestsHandler,
};
