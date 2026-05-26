/**
 * Tool 5: tspr_generate_backend_test_plan
 *
 * Scans project for Express/Fastify/Next API routes and produces a backend test plan.
 */
import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition, ToolResult, ServerContext } from '../types/mcp.js';

export const backendPlanInputSchema = z.object({
  projectPath: z.string(),
});

type BackendPlanInput = z.infer<typeof backendPlanInputSchema>;

function detectRoutes(projectPath: string): string[] {
  const routes: string[] = [];
  const routePattern =
    /(?:router|app|fastify)\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
  const nextApiDir = path.join(projectPath, 'pages', 'api');

  // Walk project files
  function walkDir(dir: string, depth: number = 0): void {
    if (depth > 5) return;
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e === 'node_modules' || e === '.git' || e === 'dist' || e === '.tspr') continue;
      const fp = path.join(dir, e);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fp);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walkDir(fp, depth + 1);
      } else if (/\.(ts|js|tsx|jsx)$/.test(e)) {
        try {
          const content = fs.readFileSync(fp, 'utf-8');
          const matches = content.matchAll(routePattern);
          for (const m of matches) {
            routes.push(`${m[1].toUpperCase()} ${m[2]}`);
          }
        } catch {
          // ignore
        }
      }
    }
  }

  walkDir(projectPath);

  // Next.js pages/api
  if (fs.existsSync(nextApiDir)) {
    function walkNextApi(dir: string, prefix: string): void {
      let entries: string[];
      try {
        entries = fs.readdirSync(dir);
      } catch {
        return;
      }
      for (const e of entries) {
        const fp = path.join(dir, e);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(fp);
        } catch {
          continue;
        }
        if (stat.isDirectory()) {
          walkNextApi(fp, `${prefix}/${e}`);
        } else {
          const route = `${prefix}/${e.replace(/\.(ts|js)$/, '')}`;
          routes.push(`GET ${route}`, `POST ${route}`);
        }
      }
    }
    walkNextApi(nextApiDir, '/api');
  }

  return [...new Set(routes)];
}

async function backendPlanHandler(args: unknown, ctx: ServerContext): Promise<ToolResult> {
  const input = args as BackendPlanInput;
  const { projectPath } = input;

  const startedAt = new Date().toISOString();
  const paramsHash = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');

  let runId: number | bigint = 0;
  try {
    const insert = ctx.db.prepare(
      `INSERT INTO runs (tool, params_hash, started_at) VALUES (?, ?, ?)`,
    );
    const result = insert.run('tspr_generate_backend_test_plan', paramsHash, startedAt);
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

    const detectedRoutes = detectRoutes(projectPath);
    const warnings: string[] = [];

    if (detectedRoutes.length === 0) {
      warnings.push('No API routes detected in the project. The test plan will be empty.');
    }

    // Read PRD if present (optional enrichment)
    let prdContext = '';
    const prdPath = path.join(projectPath, '.tspr', 'standard_prd.json');
    if (fs.existsSync(prdPath)) {
      try {
        prdContext = `\n\nPRD Context:\n${fs.readFileSync(prdPath, 'utf-8').slice(0, 2000)}`;
      } catch { /* ignore */ }
    }

    let scenarios: Array<{
      id: string;
      endpoint: string;
      type: string;
      description: string;
      testHints: string[];
    }> = [];

    if (detectedRoutes.length > 0) {
      const prompt = `You are a QA engineer. Generate backend test scenarios for the following API routes as JSON:
{
  "scenarios": [{
    "id": "<string>",
    "endpoint": "<METHOD /path>",
    "type": "happy-path"|"error"|"auth"|"integration"|"db",
    "description": "<string>",
    "testHints": ["<string>", ...]
  }, ...]
}

Routes:
${detectedRoutes.join('\n')}
${prdContext}

Return ONLY valid JSON.`;

      try {
        const ccResult = await ctx.ccClient.run({
          model: 'haiku',
          prompt,
          timeoutMs: 60_000,
        });
        const raw = ccResult.stdout.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '');
        const parsed = JSON.parse(raw) as { scenarios: typeof scenarios };
        scenarios = parsed.scenarios || [];
      } catch (err) {
        if (err instanceof McpError) throw err;
        throw new McpError(
          ErrorCode.InternalError,
          'ERR_CC_FAILED',
          { code: 'ERR_CC_FAILED', suggestion: 'Check that the claude CLI is installed and authenticated.' },
        );
      }
    }

    const outputDir = path.join(projectPath, '.tspr');
    fs.mkdirSync(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, 'backend_test_plan.json');

    const planData = { scenarios, routesDiscovered: detectedRoutes.length, warnings };
    try {
      fs.writeFileSync(outputPath, JSON.stringify(planData, null, 2), 'utf-8');
    } catch (err) {
      throw new McpError(
        ErrorCode.InternalError,
        'ERR_WRITE_FAILED',
        { code: 'ERR_WRITE_FAILED', suggestion: 'Check filesystem permissions.', cause: String(err) },
      );
    }

    const result = {
      status: 'ok',
      outputPath,
      scenarios,
      routesDiscovered: detectedRoutes.length,
      warnings,
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

export const backendPlanTool: ToolDefinition = {
  name: 'tspr_generate_backend_test_plan',
  description:
    'Scans the project for Express/Fastify/Next API routes and generates a structured backend test plan with happy-path, error, auth, integration, and db scenarios.',
  inputSchema: backendPlanInputSchema,
  handler: backendPlanHandler,
};
