/**
 * Tool 3: tspr_generate_standardized_prd
 *
 * Reads code_summary.json (auto-generates if missing) and produces a structured PRD.
 */
import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition, ToolResult, ServerContext } from '../types/mcp.js';
import { runCodeSummary } from './codeSummary.js';

export const prdInputSchema = z.object({
  projectPath: z.string(),
});

type PrdInput = z.infer<typeof prdInputSchema>;

async function prdHandler(args: unknown, ctx: ServerContext): Promise<ToolResult> {
  const input = args as PrdInput;
  const { projectPath } = input;

  const startedAt = new Date().toISOString();
  const paramsHash = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');

  let runId: number | bigint = 0;
  try {
    const insert = ctx.db.prepare(
      `INSERT INTO runs (tool, params_hash, started_at) VALUES (?, ?, ?)`,
    );
    const result = insert.run('tspr_generate_standardized_prd', paramsHash, startedAt);
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
          suggestion: 'Verify the path exists and is a Node.js project root.',
        },
      );
    }
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

    const codeSummaryPath = path.join(projectPath, '.tspr', 'code_summary.json');
    let codeSummary: string;
    if (fs.existsSync(codeSummaryPath)) {
      codeSummary = fs.readFileSync(codeSummaryPath, 'utf-8');
    } else {
      // Auto-generate summary
      const summaryOutput = await runCodeSummary(projectPath, ctx);
      codeSummary = JSON.stringify(summaryOutput);
    }

    const prompt = `You are a product manager. Based on the following code summary, generate a structured PRD as JSON with this exact schema:
{
  "productOverview": "<string>",
  "userStories": [{ "id": "<string>", "title": "<string>", "description": "<string>", "priority": "high"|"medium"|"low" }, ...],
  "functionalRequirements": ["<string>", ...],
  "technicalRequirements": ["<string>", ...]
}

Return ONLY valid JSON, no markdown, no explanation.

Code Summary:
${codeSummary}`;

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
      } catch {
        throw new McpError(
          ErrorCode.InternalError,
          'ERR_CC_FAILED',
          { code: 'ERR_CC_FAILED', suggestion: 'Check that the claude CLI is installed and authenticated.' },
        );
      }

      try {
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

    const outputDir = path.join(projectPath, '.tspr');
    fs.mkdirSync(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, 'standard_prd.json');

    try {
      fs.writeFileSync(outputPath, JSON.stringify(parsed, null, 2), 'utf-8');
    } catch (err) {
      throw new McpError(
        ErrorCode.InternalError,
        'ERR_WRITE_FAILED',
        { code: 'ERR_WRITE_FAILED', suggestion: 'Check filesystem permissions.', cause: String(err) },
      );
    }

    const productOverview = typeof parsed.productOverview === 'string' ? parsed.productOverview : '';
    const userStories = Array.isArray(parsed.userStories)
      ? (parsed.userStories as Array<{ id: string; title: string; description: string; priority: string }>)
      : [];
    const functionalRequirements = Array.isArray(parsed.functionalRequirements)
      ? (parsed.functionalRequirements as string[])
      : [];
    const technicalRequirements = Array.isArray(parsed.technicalRequirements)
      ? (parsed.technicalRequirements as string[])
      : [];

    const result = {
      status: 'ok',
      outputPath,
      productOverview,
      userStories,
      functionalRequirements,
      technicalRequirements,
    };

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

export const prdTool: ToolDefinition = {
  name: 'tspr_generate_standardized_prd',
  description:
    'Reads code_summary.json (auto-generates if missing) and produces a structured PRD with user stories, functional and technical requirements.',
  inputSchema: prdInputSchema,
  handler: prdHandler,
};
