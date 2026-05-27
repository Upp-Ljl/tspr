/**
 * Tool 4: tspr_generate_frontend_test_plan
 *
 * Runs N browser agents in parallel to explore the app and generates a frontend test plan.
 */
import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition, ToolResult, ServerContext } from '../types/mcp.js';

export const frontendPlanInputSchema = z.object({
  projectPath: z.string(),
  needLogin: z.boolean().default(true),
});

type FrontendPlanInput = z.infer<typeof frontendPlanInputSchema>;

function httpGet(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      res.resume();
      if (res.statusCode && res.statusCode < 600) {
        resolve();
      } else {
        reject(new Error(`HTTP ${res.statusCode ?? 'unknown'}`));
      }
    });
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.on('error', reject);
  });
}

async function frontendPlanHandler(args: unknown, ctx: ServerContext): Promise<ToolResult> {
  const input = args as FrontendPlanInput;
  const { projectPath } = input;

  const startedAt = new Date().toISOString();

  const runId = crypto.randomUUID();
  try {
    ctx.db.prepare(
      `INSERT INTO runs (id, tool_name, project_path, started_at, status) VALUES (?, ?, ?, ?, ?)`,
    ).run(runId, 'tspr_generate_frontend_test_plan', projectPath, startedAt, 'in-progress');
  } catch (err) {
    ctx.logger.warn('Failed to insert run row', { err });
  }

  let outcome = 'ok';
  let errorCode: string | null = null;

  try {
    // Look up the most recent bootstrap session for this projectPath directly from sessions table.
    // bootstrap.ts guarantees a row exists there after a successful call (B-4-7, B-4-8).
    let localPort: number | null = null;
    try {
      const sessionRow = ctx.db.prepare(
        `SELECT local_port FROM sessions WHERE project_path = ? ORDER BY created_at DESC LIMIT 1`,
      ).get(projectPath) as { local_port: number } | undefined;

      if (sessionRow) {
        localPort = sessionRow.local_port;
      }
    } catch {
      // sessions table may not exist in degraded mode
    }

    if (localPort === null) {
      throw new McpError(
        ErrorCode.InternalError,
        'ERR_NOT_BOOTSTRAPPED',
        {
          code: 'ERR_NOT_BOOTSTRAPPED',
          projectPath,
          suggestion: 'Call tspr_bootstrap_tests first for this project path.',
        },
      );
    }

    // Check app reachability
    try {
      await httpGet(`http://localhost:${localPort}`);
    } catch {
      throw new McpError(
        ErrorCode.InternalError,
        'ERR_APP_NOT_REACHABLE',
        {
          code: 'ERR_APP_NOT_REACHABLE',
          port: localPort,
          suggestion: `Ensure the app is running on port ${localPort}.`,
        },
      );
    }

    // Check Playwright
    try {
      await import('@playwright/test');
    } catch {
      throw new McpError(
        ErrorCode.InternalError,
        'ERR_PLAYWRIGHT_MISSING',
        {
          code: 'ERR_PLAYWRIGHT_MISSING',
          suggestion: 'Install Playwright in the server environment: npm install @playwright/test',
        },
      );
    }

    const prompt = `You are a QA agent. Explore the app at http://localhost:${localPort}. Visit all reachable pages, interact with forms, note UI patterns and error states. Output JSON:
{
  "pages": ["<url path>", ...],
  "interactions": ["<description>", ...]
}
Return ONLY valid JSON.`;

    const N = ctx.config.browserPoolSize;
    const agentPromises: Promise<{ pages: string[]; interactions: string[] }>[] = [];

    for (let i = 0; i < N; i++) {
      agentPromises.push(
        ctx.llmClient
          .run({ model: 'sonnet', prompt, timeoutMs: 300_000 })
          .then((res) => {
            try {
              const raw = res.stdout.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '');
              return JSON.parse(raw) as { pages: string[]; interactions: string[] };
            } catch {
              return { pages: [], interactions: [] };
            }
          })
          .catch(() => ({ pages: [], interactions: [] })),
      );
    }

    const results = await Promise.allSettled(agentPromises);
    const allPages = new Set<string>();
    const allInteractions = new Set<string>();

    for (const r of results) {
      if (r.status === 'fulfilled') {
        for (const p of r.value.pages) allPages.add(p);
        for (const i of r.value.interactions) allInteractions.add(i);
      }
    }

    if (allPages.size === 0 && allInteractions.size === 0) {
      throw new McpError(
        ErrorCode.InternalError,
        'ERR_EXPLORATION_TIMEOUT',
        {
          code: 'ERR_EXPLORATION_TIMEOUT',
          suggestion: 'Increase timeout or simplify the app.',
        },
      );
    }

    // Generate test scenarios from coverage
    const coveragePrompt = `Based on the following UI coverage from a web app, generate frontend test scenarios as JSON:
{
  "scenarios": [{
    "id": "<string>",
    "title": "<string>",
    "type": "navigation"|"form"|"visual-regression"|"interaction",
    "steps": ["<string>", ...],
    "assertions": ["<string>", ...]
  }, ...]
}

Pages: ${JSON.stringify([...allPages])}
Interactions: ${JSON.stringify([...allInteractions])}

Return ONLY valid JSON.`;

    let scenarios: Array<{
      id: string;
      title: string;
      type: string;
      steps: string[];
      assertions: string[];
    }> = [];

    try {
      const scenarioResult = await ctx.llmClient.run({
        model: 'haiku',
        prompt: coveragePrompt,
        timeoutMs: 60_000,
      });
      const raw = scenarioResult.stdout.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '');
      const parsed = JSON.parse(raw) as { scenarios: typeof scenarios };
      scenarios = parsed.scenarios || [];
    } catch {
      // best-effort; return empty scenarios
    }

    const outputDir = path.join(projectPath, '.tspr');
    fs.mkdirSync(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, 'frontend_test_plan.json');

    const planData = { scenarios, pagesDiscovered: allPages.size, interactionsDiscovered: allInteractions.size };
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
      pagesDiscovered: allPages.size,
      interactionsDiscovered: allInteractions.size,
    };

    const endedAt = new Date().toISOString();
    try {
      ctx.db.prepare(`UPDATE runs SET status = ?, completed_at = ? WHERE id = ?`)
        .run('ok', endedAt, runId);
    } catch { /* ignore */ }

    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (err) {
    outcome = 'error';
    if (err instanceof McpError) {
      const data = err.data as { code?: string } | undefined;
      errorCode = data?.code ?? null;
    }
    const endedAt = new Date().toISOString();
    try {
      ctx.db.prepare(`UPDATE runs SET status = ?, completed_at = ?, error_code = ? WHERE id = ?`)
        .run('error', endedAt, errorCode, runId);
    } catch { /* ignore */ }
    throw err;
  }
}

export const frontendPlanTool: ToolDefinition = {
  name: 'tspr_generate_frontend_test_plan',
  description:
    'Runs parallel browser agents to explore the running app and generates a frontend test plan with navigation, form, visual-regression, and interaction scenarios.',
  inputSchema: frontendPlanInputSchema,
  handler: frontendPlanHandler,
};
