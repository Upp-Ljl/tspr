/**
 * Tool 7: localsprite_open_test_result_dashboard
 *
 * Queries run history from SQLite and renders a static dashboard HTML file.
 */
import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition, ToolResult, ServerContext } from '../types/mcp.js';

export const dashboardInputSchema = z.object({}).passthrough();

async function dashboardHandler(args: unknown, ctx: ServerContext): Promise<ToolResult> {
  const startedAt = new Date().toISOString();
  const paramsHash = crypto.createHash('sha256').update(JSON.stringify(args ?? {})).digest('hex');

  let runId: number | bigint = 0;
  try {
    const insert = ctx.db.prepare(
      `INSERT INTO runs (tool, params_hash, started_at) VALUES (?, ?, ?)`,
    );
    const result = insert.run('localsprite_open_test_result_dashboard', paramsHash, startedAt);
    runId = result.lastInsertRowid;
  } catch (err) {
    ctx.logger.warn('Failed to insert run row', { err });
  }

  let outcome = 'ok';
  let errorCode: string | null = null;

  try {
    // Query last 20 completed runs (all tools, success + error)
    let runs: Array<{
      id: number;
      tool: string;
      outcome: string | null;
      started_at: string;
      ended_at: string | null;
      duration_ms: number | null;
      error_code: string | null;
    }> = [];

    try {
      runs = ctx.db.prepare(
        `SELECT id, tool, outcome, started_at, ended_at, duration_ms, error_code
         FROM runs
         WHERE outcome IS NOT NULL
         ORDER BY id DESC
         LIMIT 20`,
      ).all() as typeof runs;
    } catch {
      throw new McpError(
        ErrorCode.InternalError,
        'ERR_DB_UNINITIALIZED',
        {
          code: 'ERR_DB_UNINITIALIZED',
          suggestion: 'This is a server startup bug. Restart the server.',
        },
      );
    }

    // Count all completed runs (across all 8 tools) including current dashboard call
    // runCount counts all tool calls that have a completed row (outcome IS NOT NULL)
    // This call's row has outcome = NULL so far; count existing completed rows
    let runCount = 0;
    try {
      const countRow = ctx.db.prepare(
        `SELECT COUNT(*) as cnt FROM runs WHERE outcome IS NOT NULL`,
      ).get() as { cnt: number } | undefined;
      runCount = countRow?.cnt ?? 0;
    } catch { /* ignore */ }

    const lastRun = runs.length > 0 ? runs[0] : null;
    const lastRunAt = lastRun?.ended_at ?? null;

    // Render dashboard HTML
    const dashboardDir = path.join(os.homedir(), '.localsprite');
    const dashboardPath = path.join(dashboardDir, 'dashboard.html');

    try {
      fs.mkdirSync(dashboardDir, { recursive: true });
    } catch { /* ignore */ }

    const runsHtml = runs
      .map(
        (r) =>
          `<tr>
  <td>${r.id}</td>
  <td>${r.tool}</td>
  <td>${r.outcome ?? 'running'}</td>
  <td>${r.started_at}</td>
  <td>${r.ended_at ?? '—'}</td>
  <td>${r.duration_ms != null ? `${r.duration_ms}ms` : '—'}</td>
  <td>${r.error_code ?? '—'}</td>
</tr>`,
      )
      .join('\n');

    const html = `<!DOCTYPE html>
<html>
<head>
<title>localsprite Dashboard</title>
<style>
body { font-family: sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #ccc; padding: 8px; text-align: left; }
th { background: #f0f0f0; }
tr:nth-child(even) { background: #f9f9f9; }
</style>
</head>
<body>
<h1>localsprite Test Dashboard</h1>
<p>Run count: <strong>${runCount}</strong></p>
<p>Last run: <strong>${lastRunAt ?? 'Never'}</strong></p>
<h2>Recent Runs (last 20)</h2>
<table>
<thead><tr><th>ID</th><th>Tool</th><th>Outcome</th><th>Started</th><th>Ended</th><th>Duration</th><th>Error</th></tr></thead>
<tbody>${runsHtml}</tbody>
</table>
</body>
</html>`;

    try {
      fs.writeFileSync(dashboardPath, html, 'utf-8');
    } catch (err) {
      throw new McpError(
        ErrorCode.InternalError,
        'ERR_RENDER_FAILED',
        { code: 'ERR_RENDER_FAILED', suggestion: 'Retry; if persistent, file a bug.', cause: String(err) },
      );
    }

    const dashboardUrl = `file://${dashboardPath.replace(/\\/g, '/')}`;

    const result = {
      status: 'ok',
      dashboardUrl,
      runCount,
      lastRunAt,
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

export const dashboardTool: ToolDefinition = {
  name: 'localsprite_open_test_result_dashboard',
  description:
    'Queries run history from SQLite, renders a static dashboard HTML file, and returns the file:// URL.',
  inputSchema: dashboardInputSchema,
  handler: dashboardHandler,
};
