/**
 * src/dashboard/server.ts
 *
 * Local HTTP dashboard server for tspr. Zero external deps — uses only
 * node:http, node:fs, node:path, node:os, node:url.
 *
 * Routes (existing):
 *   GET /                        → index.html (projects + issues view)
 *   GET /api/runs                → JSON array of runs (newest first)
 *   GET /api/runs/:runId         → JSON single run + test_results
 *   GET /runs/:runId             → run.html with run detail (side panel)
 *   GET /style.css               → dashboard CSS
 *   GET /app.js                  → dashboard JS
 *   GET /artifacts/:runId/:file  → static file from ~/.tspr/runs/<runId>/<file>
 *
 * Routes (new):
 *   GET /compare                 → compare.html (two-run diff view)
 *   GET /cost                    → cost.html (token/spend view)
 *   GET /api/projects            → project health summary list
 *   GET /api/issues              → top failures aggregated cross-run
 *   GET /api/trends?days=N       → pass rate over time
 *   GET /api/compare?a=X&b=Y     → diff between two runs
 *   GET /api/file?path=<abs>     → file content (allowlist-gated)
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { aggregateTopIssues } from './issues.js';
import { compareRuns } from './compare.js';
import { applyPatch, pushPr, mergeLocal, GitOpsError } from '../git-ops/index.js';

// ─── public interface ─────────────────────────────────────────────────────────

export interface DashboardOptions {
  /** HTTP port. Default: 7654 */
  port?: number;
  /** Auto-open browser. Default: true */
  open?: boolean;
  /** Bind host. Default: '127.0.0.1' */
  host?: string;
  /** Path to db.sqlite. Default: ~/.tspr/db.sqlite */
  dbPath?: string;
  /** Additional allowed directories for /api/file. Default: [] */
  extraAllowedPaths?: string[];
}

export interface DashboardHandle {
  url: string;
  close: () => Promise<void>;
}

// ─── SQLite row shapes ────────────────────────────────────────────────────────

/** Real schema (TEXT PK, tool_name, project_path, status) */
interface RunRowReal {
  id: string;
  tool_name: string;
  project_path: string | null;
  started_at: string;
  completed_at: string | null;
  status: string;
  error_code: string | null;
}

/** Legacy schema (INTEGER PK, tool, outcome) — kept for tests that use old schema */
interface RunRowLegacy {
  id: number;
  session_id: string | null;
  tool: string;
  params_hash: string;
  started_at: string;
  ended_at: string | null;
  outcome: string | null;
  error_code: string | null;
  duration_ms: number | null;
}

/** Normalized run row used internally */
interface RunRow {
  id: string;
  tool: string;
  projectPath: string | null;
  startedAt: string;
  completedAt: string | null;
  status: string;
  errorCode: string | null;
  durationMs: number | null;
}

interface TestResultRow {
  id: string;
  runId: string;
  testId: string;
  testName: string;
  testFile: string;
  testType: string;
  status: string;
  errorMessage: string | null;
  durationMs: number | null;
  suggestedFixRegion: string | null;
  suggestedPatch: string | null;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(__dirname, 'ui');

function readUiFile(name: string): string {
  return fs.readFileSync(path.join(UI_DIR, name), 'utf-8');
}

export function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function projectLabel(projectPath: string | null | undefined): string {
  if (!projectPath) return '—';
  const parts = projectPath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] ?? projectPath;
}

export function formatMs(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const delta = (Date.now() - new Date(iso).getTime()) / 1000;
  if (delta < 60) return `${Math.round(delta)}s ago`;
  if (delta < 3600) return `${Math.round(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.round(delta / 3600)}h ago`;
  return `${Math.round(delta / 86400)}d ago`;
}

function applyTemplate(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.split(`{{${key}}}`).join(value);
  }
  return result;
}

// ─── SQLite read-only helpers ─────────────────────────────────────────────────

interface DbHandle {
  getRuns(): RunRow[];
  getRun(id: string): RunRow | undefined;
  getTestResults(runId: string): TestResultRow[];
  getProjectPaths(): string[];
  close(): void;
  raw: unknown; // for passing to aggregators
}

function normalizeRunReal(r: RunRowReal): RunRow {
  return {
    id: String(r.id),
    tool: r.tool_name ?? '',
    projectPath: r.project_path ?? null,
    startedAt: r.started_at,
    completedAt: r.completed_at ?? null,
    status: r.status ?? 'in-progress',
    errorCode: r.error_code ?? null,
    durationMs: null,
  };
}

function normalizeRunLegacy(r: RunRowLegacy): RunRow {
  // Map old 'outcome' field → status
  let status = (r.outcome ?? 'in-progress').toLowerCase();
  if (status === 'ok') status = 'ok';
  return {
    id: String(r.id),
    tool: (r as RunRowLegacy).tool ?? '',
    projectPath: null,
    startedAt: r.started_at,
    completedAt: (r as RunRowLegacy).ended_at ?? null,
    status,
    errorCode: r.error_code ?? null,
    durationMs: (r as RunRowLegacy).duration_ms ?? null,
  };
}

async function openSqlite(dbFilePath: string): Promise<DbHandle> {
  const { default: Database } = await import('better-sqlite3') as { default: typeof import('better-sqlite3') };

  if (!fs.existsSync(dbFilePath)) {
    return {
      getRuns: () => [],
      getRun: () => undefined,
      getTestResults: () => [],
      getProjectPaths: () => [],
      close: () => undefined,
      raw: null,
    };
  }

  const db = new Database(dbFilePath, { readonly: true, fileMustExist: true });

  // Detect which schema we have
  const hasRealSchema = (() => {
    try {
      const info = db.prepare(`PRAGMA table_info(runs)`).all() as Array<{ name: string }>;
      return info.some((c) => c.name === 'tool_name');
    } catch {
      return false;
    }
  })();

  const hasLegacySchema = !hasRealSchema;

  return {
    getRuns(): RunRow[] {
      try {
        if (hasRealSchema) {
          const rows = db.prepare<[], RunRowReal>(
            `SELECT * FROM runs ORDER BY started_at DESC LIMIT 500`,
          ).all();
          return rows.map(normalizeRunReal);
        } else {
          const rows = db.prepare<[], RunRowLegacy>(
            `SELECT * FROM runs ORDER BY id DESC LIMIT 500`,
          ).all();
          return rows.map(normalizeRunLegacy);
        }
      } catch {
        return [];
      }
    },
    getRun(id: string): RunRow | undefined {
      try {
        if (hasRealSchema) {
          const r = db.prepare<[string], RunRowReal>(`SELECT * FROM runs WHERE id = ?`).get(id);
          return r ? normalizeRunReal(r) : undefined;
        } else {
          const numId = parseInt(id, 10);
          if (isNaN(numId)) return undefined;
          const r = db.prepare<[number], RunRowLegacy>(`SELECT * FROM runs WHERE id = ?`).get(numId);
          return r ? normalizeRunLegacy(r) : undefined;
        }
      } catch {
        return undefined;
      }
    },
    getTestResults(runId: string): TestResultRow[] {
      try {
        if (hasRealSchema) {
          return db.prepare<[string], {
            id: string; run_id: string; test_id: string; test_name: string;
            test_file: string; test_type: string; status: string;
            error_message: string | null; duration_ms: number | null;
            suggested_fix_region: string | null; suggested_patch: string | null;
          }>(`SELECT * FROM test_results WHERE run_id = ?`).all(runId).map((r) => ({
            id: r.id,
            runId: r.run_id,
            testId: r.test_id,
            testName: r.test_name,
            testFile: r.test_file ?? '',
            testType: r.test_type ?? '',
            status: r.status,
            errorMessage: r.error_message ?? null,
            durationMs: r.duration_ms ?? null,
            suggestedFixRegion: r.suggested_fix_region ?? null,
            suggestedPatch: r.suggested_patch ?? null,
          }));
        } else {
          // Legacy schema: id INTEGER, run_id INTEGER, test_id TEXT, title TEXT, outcome TEXT, stack TEXT
          const numId = parseInt(runId, 10);
          if (isNaN(numId)) return [];
          return db.prepare<[number], {
            id: number; run_id: number; test_id: string;
            title: string | null; outcome: string | null; stack: string | null;
          }>(`SELECT * FROM test_results WHERE run_id = ?`).all(numId).map((r) => ({
            id: String(r.id),
            runId: runId,
            testId: r.test_id,
            testName: r.title ?? r.test_id,
            testFile: '',
            testType: '',
            status: r.outcome ?? 'unknown',
            errorMessage: r.stack ?? null,
            durationMs: null,
            suggestedFixRegion: null,
            suggestedPatch: null,
          }));
        }
      } catch {
        return [];
      }
    },
    getProjectPaths(): string[] {
      try {
        if (hasRealSchema) {
          return db.prepare<[], { project_path: string }>(
            `SELECT DISTINCT project_path FROM runs WHERE project_path IS NOT NULL`,
          ).all().map((r) => r.project_path);
        }
        return [];
      } catch {
        return [];
      }
    },
    close(): void {
      try { db.close(); } catch { /* ignore */ }
    },
    raw: db,
  };
}

// ─── File allowlist security ──────────────────────────────────────────────────

/**
 * Build the set of allowed root directories for /api/file.
 * Returns normalized absolute paths.
 */
function buildAllowlist(projectPaths: string[], extraPaths: string[]): string[] {
  const tspr = path.join(os.homedir(), '.tspr');
  const allowed = [tspr, ...projectPaths, ...extraPaths].map((p) =>
    path.normalize(p).replace(/\\/g, '/'),
  );
  return [...new Set(allowed)];
}

function isPathAllowed(filePath: string, allowlist: string[]): boolean {
  const normalized = path.normalize(filePath).replace(/\\/g, '/');
  return allowlist.some((root) => normalized.startsWith(root + '/') || normalized === root);
}

// ─── Project health ───────────────────────────────────────────────────────────

interface ProjectHealth {
  projectPath: string;
  projectName: string;
  lastRunId: string;
  lastRunAt: string;
  status: 'healthy' | 'issues' | 'broken';
  passRate: number;
  passingTests: number;
  totalTests: number;
  delta: number; // change vs previous run (passed count diff)
  previousPassRate: number | null;
  runCount: number;
}

function computeProjectHealth(
  projectPath: string,
  runs: RunRow[],
  db: DbHandle,
): ProjectHealth {
  const projectRuns = runs
    .filter((r) => r.projectPath === projectPath)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  const runCount = projectRuns.length;
  const lastRun = projectRuns[0];
  const prevRun = projectRuns[1];

  let passingTests = 0;
  let totalTests = 0;
  let prevPassing = 0;
  let prevTotal = 0;

  if (lastRun) {
    const results = db.getTestResults(lastRun.id);
    totalTests = results.length;
    passingTests = results.filter((r) => r.status === 'passed').length;
  }

  if (prevRun) {
    const results = db.getTestResults(prevRun.id);
    prevTotal = results.length;
    prevPassing = results.filter((r) => r.status === 'passed').length;
  }

  const passRate = totalTests > 0 ? passingTests / totalTests : 0;
  const previousPassRate = prevTotal > 0 ? prevPassing / prevTotal : null;
  const delta = prevRun ? passingTests - prevPassing : 0;

  let status: 'healthy' | 'issues' | 'broken';
  if (passRate >= 0.9) status = 'healthy';
  else if (passRate >= 0.5) status = 'issues';
  else status = 'broken';

  return {
    projectPath,
    projectName: projectLabel(projectPath),
    lastRunId: lastRun?.id ?? '',
    lastRunAt: lastRun?.startedAt ?? '',
    status,
    passRate,
    passingTests,
    totalTests,
    delta,
    previousPassRate,
    runCount,
  };
}

// ─── Trends ──────────────────────────────────────────────────────────────────

interface TrendPoint {
  date: string; // YYYY-MM-DD
  passRate: number;
  total: number;
  passed: number;
}

function computeTrends(
  runs: RunRow[],
  db: DbHandle,
  days = 30,
): TrendPoint[] {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const recentRuns = runs.filter((r) => r.startedAt >= cutoff && r.status !== 'in-progress');

  // Group by date
  const byDate = new Map<string, { passed: number; total: number }>();

  for (const run of recentRuns) {
    const date = run.startedAt.slice(0, 10);
    const results = db.getTestResults(run.id);
    if (results.length === 0) continue;
    const existing = byDate.get(date) ?? { passed: 0, total: 0 };
    existing.total += results.length;
    existing.passed += results.filter((r) => r.status === 'passed').length;
    byDate.set(date, existing);
  }

  const points: TrendPoint[] = [];
  for (const [date, stats] of byDate) {
    points.push({
      date,
      passRate: stats.total > 0 ? stats.passed / stats.total : 0,
      total: stats.total,
      passed: stats.passed,
    });
  }

  return points.sort((a, b) => a.date.localeCompare(b.date));
}

// ─── HTTP send helpers ────────────────────────────────────────────────────────

function send(res: http.ServerResponse, status: number, contentType: string, body: string | Buffer): void {
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf-8') : body;
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': buf.length,
    'Cache-Control': 'no-cache',
  });
  res.end(buf);
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(data, null, 2));
}

function sendHtml(res: http.ServerResponse, html: string): void {
  send(res, 200, 'text/html; charset=utf-8', html);
}

function sendNotFound(res: http.ServerResponse, msg = 'Not found'): void {
  sendJson(res, 404, { error: msg });
}

// ─── POST route handler ───────────────────────────────────────────────────────

function handlePost(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  urlPath: string,
  db: DbHandle,
  extraAllowedPaths: string[],
  readBody: (req: http.IncomingMessage) => Promise<string>,
): void {
  // All POST routes are async — wrap errors
  const run = async () => {
    let bodyStr = '';
    try { bodyStr = await readBody(req); } catch {
      sendJson(res, 400, { error: 'Failed to read request body' });
      return;
    }

    let body: Record<string, unknown> = {};
    try { body = JSON.parse(bodyStr) as Record<string, unknown>; } catch {
      sendJson(res, 400, { error: 'Request body must be valid JSON' });
      return;
    }

    // ── POST /api/apply-fix ────────────────────────────────────────────────
    if (urlPath === '/api/apply-fix') {
      const issueId = String(body.issueId ?? '');
      const projectPath = String(body.projectPath ?? '');
      const branch = body.branch ? String(body.branch) : undefined;
      const commit = body.commit !== false; // default true
      const dryRun = body.dryRun === true;

      if (!issueId || !projectPath) {
        sendJson(res, 400, { error: 'issueId and projectPath are required' });
        return;
      }

      // Validate path is in allowlist
      const projectPaths = db.getProjectPaths();
      const allowlist = buildAllowlist(projectPaths, extraAllowedPaths);
      if (!isPathAllowed(projectPath, allowlist)) {
        sendJson(res, 403, { error: 'projectPath is outside allowed directories' });
        return;
      }

      // Load test_results.json from project
      const tsprDir = path.join(projectPath, '.tspr');
      const resultsPath = path.join(tsprDir, 'test_results.json');
      if (!fs.existsSync(resultsPath)) {
        sendJson(res, 404, { error: 'No test_results.json found for project' });
        return;
      }

      let stored: { failures?: Array<{
        testId: string; title?: string; stack?: string; issueId?: string;
        suggestedPatch?: string;
        suggestedFixRegion?: { file: string; lineStart: number; lineEnd: number; why: string };
      }> };
      try {
        stored = JSON.parse(fs.readFileSync(resultsPath, 'utf-8')) as typeof stored;
      } catch {
        sendJson(res, 500, { error: 'Failed to parse test_results.json' });
        return;
      }

      const { computeStableIssueId } = await import('./issues.js');
      const failure = (stored.failures ?? []).find((f) => {
        const computedId = computeStableIssueId(f.testId, projectPath);
        return (
          f.issueId === issueId ||
          computedId === issueId ||
          computedId.startsWith(issueId) ||
          issueId.startsWith(computedId.slice(0, issueId.length))
        );
      });

      if (!failure) {
        sendJson(res, 404, { error: `Issue ${issueId} not found in test_results.json` });
        return;
      }

      if (!failure.suggestedPatch) {
        const fix = failure.suggestedFixRegion;
        sendJson(res, 200, {
          applied: false,
          message: fix
            ? `No auto-fix patch available. Look at: ${fix.file}:${fix.lineStart}–${fix.lineEnd} — ${fix.why}`
            : 'No auto-fix patch available.',
          files: [],
          branch: '',
        });
        return;
      }

      try {
        const result = await applyPatch({
          projectPath,
          patch: failure.suggestedPatch,
          issueId,
          testTitle: failure.title ?? failure.testId,
          branch,
          noCommit: !commit,
          opts: { dryRun },
        });
        sendJson(res, 200, {
          applied: result.applied,
          branch: result.branch,
          commitSha: result.commitSha,
          files: result.files,
          message: result.message,
          dryRun: result.dryRun,
        });
      } catch (err) {
        if (err instanceof GitOpsError) {
          sendJson(res, 422, { error: err.message, code: err.code });
        } else {
          sendJson(res, 500, { error: String(err) });
        }
      }
      return;
    }

    // ── POST /api/push-pr ──────────────────────────────────────────────────
    if (urlPath === '/api/push-pr') {
      const branchParam = String(body.branch ?? '');
      const base = String(body.base ?? 'main');
      const title = body.title ? String(body.title) : undefined;
      const projectPath = String(body.projectPath ?? '');
      const dryRun = body.dryRun === true;

      if (!branchParam || !projectPath) {
        sendJson(res, 400, { error: 'branch and projectPath are required' });
        return;
      }

      const projectPaths = db.getProjectPaths();
      const allowlist = buildAllowlist(projectPaths, extraAllowedPaths);
      if (!isPathAllowed(projectPath, allowlist)) {
        sendJson(res, 403, { error: 'projectPath is outside allowed directories' });
        return;
      }

      try {
        const result = await pushPr({ projectPath, branch: branchParam, base, title, opts: { dryRun } });
        sendJson(res, 200, result);
      } catch (err) {
        if (err instanceof GitOpsError) {
          sendJson(res, 422, { error: err.message, code: err.code });
        } else {
          sendJson(res, 500, { error: String(err) });
        }
      }
      return;
    }

    // ── POST /api/merge-local ──────────────────────────────────────────────
    if (urlPath === '/api/merge-local') {
      const branchParam = String(body.branch ?? '');
      const base = String(body.base ?? 'main');
      const projectPath = String(body.projectPath ?? '');
      const dryRun = body.dryRun === true;

      if (!branchParam || !projectPath) {
        sendJson(res, 400, { error: 'branch and projectPath are required' });
        return;
      }

      const projectPaths = db.getProjectPaths();
      const allowlist = buildAllowlist(projectPaths, extraAllowedPaths);
      if (!isPathAllowed(projectPath, allowlist)) {
        sendJson(res, 403, { error: 'projectPath is outside allowed directories' });
        return;
      }

      try {
        const result = await mergeLocal({ projectPath, branch: branchParam, base, opts: { dryRun } });
        sendJson(res, 200, result);
      } catch (err) {
        if (err instanceof GitOpsError) {
          sendJson(res, 422, { error: err.message, code: err.code });
        } else {
          sendJson(res, 500, { error: String(err) });
        }
      }
      return;
    }

    sendJson(res, 404, { error: 'POST route not found' });
  };

  run().catch((err) => {
    try { sendJson(res, 500, { error: String(err) }); } catch { /* ignore */ }
  });
}

// ─── Route handler ────────────────────────────────────────────────────────────

function makeHandler(
  db: DbHandle,
  cssContent: string,
  jsContent: string,
  indexTemplate: string,
  runTemplate: string,
  compareTemplate: string,
  costTemplate: string,
  extraAllowedPaths: string[],
) {
  // ── Body reader ───────────────────────────────────────────────────────────

  function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => resolve(body));
      req.on('error', reject);
      req.setTimeout(5000, () => reject(new Error('body read timeout')));
    });
  }

  return function handler(req: http.IncomingMessage, res: http.ServerResponse): void {
    const rawUrl = req.url ?? '/';
    const [urlPath, queryString] = rawUrl.split('?');
    const params = new URLSearchParams(queryString ?? '');
    const method = req.method ?? 'GET';

    // ── POST routes (new: local-advantage) ────────────────────────────────
    if (method === 'POST') {
      handlePost(req, res, urlPath, db, extraAllowedPaths, readBody);
      return;
    }

    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    // ── Static assets ──────────────────────────────────────────────────────
    if (urlPath === '/style.css') {
      send(res, 200, 'text/css; charset=utf-8', cssContent);
      return;
    }

    if (urlPath === '/app.js') {
      send(res, 200, 'application/javascript; charset=utf-8', jsContent);
      return;
    }

    // ── /api/runs ──────────────────────────────────────────────────────────
    if (urlPath === '/api/runs' || urlPath === '/api/runs/') {
      const runs = db.getRuns();
      sendJson(res, 200, runs.map((r) => ({
        id: r.id,
        tool: r.tool,
        project_path: r.projectPath,
        started_at: r.startedAt,
        completed_at: r.completedAt,
        outcome: r.status,
        status: r.status,
        error_code: r.errorCode,
        duration_ms: r.durationMs,
      })));
      return;
    }

    // ── /api/runs/:runId ───────────────────────────────────────────────────
    const apiRunMatch = urlPath.match(/^\/api\/runs\/([^/?]+)$/);
    if (apiRunMatch) {
      const runId = decodeURIComponent(apiRunMatch[1]);
      const run = db.getRun(runId);
      if (!run) {
        sendNotFound(res, `Run ${runId} not found`);
        return;
      }
      const testResults = db.getTestResults(runId);
      sendJson(res, 200, {
        run: {
          id: run.id,
          tool: run.tool,
          project_path: run.projectPath,
          started_at: run.startedAt,
          completed_at: run.completedAt,
          outcome: run.status,
          status: run.status,
          error_code: run.errorCode,
          duration_ms: run.durationMs,
        },
        testResults,
      });
      return;
    }

    // ── /api/projects ──────────────────────────────────────────────────────
    if (urlPath === '/api/projects' || urlPath === '/api/projects/') {
      const runs = db.getRuns();
      // Get unique project paths
      const projectPaths = [...new Set(
        runs.map((r) => r.projectPath).filter((p): p is string => p != null),
      )];

      if (projectPaths.length === 0) {
        // Fall back: group by tool if no project paths
        sendJson(res, 200, []);
        return;
      }

      const projects = projectPaths.map((pp) => computeProjectHealth(pp, runs, db));
      sendJson(res, 200, projects);
      return;
    }

    // ── /api/issues ────────────────────────────────────────────────────────
    if (urlPath === '/api/issues' || urlPath === '/api/issues/') {
      const runs = db.getRuns();
      const issueDb = {
        getRunsForIssues: () => runs.map((r) => ({
          id: r.id,
          project_path: r.projectPath,
          started_at: r.startedAt,
          status: r.status,
        })),
        getFailedResultsForRun: (runId: string) => {
          const results = db.getTestResults(runId);
          return results
            .filter((r) => r.status === 'failed')
            .map((r) => ({
              test_id: r.testId,
              test_name: r.testName,
              error_message: r.errorMessage,
              suggested_fix_region: r.suggestedFixRegion,
              suggested_patch: r.suggestedPatch,
            }));
        },
      };
      const limitStr = params.get('limit');
      const limit = limitStr ? parseInt(limitStr, 10) : 20;
      const issues = aggregateTopIssues(issueDb, isNaN(limit) ? 20 : limit);
      sendJson(res, 200, issues);
      return;
    }

    // ── /api/trends ────────────────────────────────────────────────────────
    if (urlPath === '/api/trends' || urlPath === '/api/trends/') {
      const daysStr = params.get('days');
      const days = daysStr ? parseInt(daysStr, 10) : 30;
      const runs = db.getRuns();
      const trends = computeTrends(runs, db, isNaN(days) ? 30 : days);
      sendJson(res, 200, trends);
      return;
    }

    // ── /api/compare ───────────────────────────────────────────────────────
    if (urlPath === '/api/compare' || urlPath === '/api/compare/') {
      const runA = params.get('a') ?? '';
      const runB = params.get('b') ?? '';
      if (!runA || !runB) {
        sendJson(res, 400, { error: 'Both ?a= and ?b= are required' });
        return;
      }
      const compareDb = {
        getTestOutcomesForRun: (runId: string) => {
          const results = db.getTestResults(runId);
          return results.map((r) => ({
            test_id: r.testId,
            test_name: r.testName,
            status: r.status,
          }));
        },
        runExists: (runId: string) => db.getRun(runId) != null,
      };
      const result = compareRuns(compareDb, runA, runB);
      sendJson(res, 200, result);
      return;
    }

    // ── /api/file ──────────────────────────────────────────────────────────
    if (urlPath === '/api/file' || urlPath === '/api/file/') {
      const filePath = params.get('path');
      if (!filePath) {
        sendJson(res, 400, { error: '?path= is required' });
        return;
      }
      // Build allowlist from project paths + ~/.tspr + extraAllowedPaths
      const projectPaths = db.getProjectPaths();
      const allowlist = buildAllowlist(projectPaths, extraAllowedPaths);

      if (!isPathAllowed(filePath, allowlist)) {
        sendJson(res, 403, { error: 'Path is outside allowed directories' });
        return;
      }

      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        sendJson(res, 200, { path: filePath, content, lines: content.split('\n').length });
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'ENOENT') {
          sendNotFound(res, `File not found: ${filePath}`);
        } else {
          sendJson(res, 500, { error: `Failed to read file: ${e.message}` });
        }
      }
      return;
    }

    // ── /api/stats (quick stats) ───────────────────────────────────────────
    if (urlPath === '/api/stats' || urlPath === '/api/stats/') {
      const runs = db.getRuns();
      const totalRuns = runs.length;
      let totalTestsRun = 0;
      let totalPassed = 0;

      // Sample last 50 runs for stats (avoid full scan)
      const sampleRuns = runs.slice(0, 50);
      for (const run of sampleRuns) {
        const results = db.getTestResults(run.id);
        totalTestsRun += results.length;
        totalPassed += results.filter((r) => r.status === 'passed').length;
      }

      const avgPassRate = totalTestsRun > 0 ? totalPassed / totalTestsRun : 0;

      sendJson(res, 200, {
        totalRuns,
        totalTestsRun,
        avgPassRate,
        totalSpentUsd: null, // not tracked yet
      });
      return;
    }

    // ── /compare page ──────────────────────────────────────────────────────
    if (urlPath === '/compare' || urlPath === '/compare/') {
      sendHtml(res, compareTemplate);
      return;
    }

    // ── /cost page ─────────────────────────────────────────────────────────
    if (urlPath === '/cost' || urlPath === '/cost/') {
      sendHtml(res, costTemplate);
      return;
    }

    // ── /runs/:runId ───────────────────────────────────────────────────────
    const runPageMatch = urlPath.match(/^\/runs\/([^/?]+)$/);
    if (runPageMatch) {
      const runId = decodeURIComponent(runPageMatch[1]);
      const run = db.getRun(runId);
      if (!run) {
        sendNotFound(res, `Run ${runId} not found`);
        return;
      }
      const testResults = db.getTestResults(runId);
      const runJson = JSON.stringify({
        id: run.id,
        tool: run.tool,
        projectPath: run.projectPath,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        status: run.status,
        errorCode: run.errorCode,
        durationMs: run.durationMs,
      });
      const html = applyTemplate(runTemplate, {
        RUN_ID: escHtml(run.id),
        RUN_STATUS: escHtml(run.status),
        PROJECT_NAME: escHtml(projectLabel(run.projectPath)),
        RUN_JSON: escHtml(runJson),
        TEST_RESULTS_JSON: escHtml(JSON.stringify(testResults)),
      });
      sendHtml(res, html);
      return;
    }

    // ── /artifacts/:runId/:file ────────────────────────────────────────────
    const artifactMatch = urlPath.match(/^\/artifacts\/([^/]+)\/(.+)$/);
    if (artifactMatch) {
      const runId = decodeURIComponent(artifactMatch[1]);
      const fileName = decodeURIComponent(artifactMatch[2]);
      const safeName = path.basename(fileName);
      const artifactPath = path.join(os.homedir(), '.tspr', 'runs', runId, safeName);
      try {
        const content = fs.readFileSync(artifactPath);
        const ext = path.extname(safeName).toLowerCase();
        const ctMap: Record<string, string> = {
          '.json': 'application/json',
          '.html': 'text/html',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.txt': 'text/plain',
        };
        const ct = ctMap[ext] ?? 'application/octet-stream';
        send(res, 200, ct, content);
      } catch {
        sendNotFound(res, `Artifact not found: ${safeName}`);
      }
      return;
    }

    // ── / (home) ───────────────────────────────────────────────────────────
    if (urlPath === '/' || urlPath === '/index.html') {
      sendHtml(res, indexTemplate);
      return;
    }

    sendNotFound(res);
  };
}

// ─── Browser open ─────────────────────────────────────────────────────────────

function openBrowser(url: string): void {
  const platform = process.platform;
  let cmd: string;
  let args: string[];

  if (platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '', url];
  } else if (platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }

  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {
    // Best-effort
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function startDashboard(opts?: DashboardOptions): Promise<DashboardHandle> {
  const port = opts?.port ?? 7654;
  const host = opts?.host ?? '127.0.0.1';
  const shouldOpen = opts?.open ?? true;
  const dbFilePath = opts?.dbPath ?? path.join(os.homedir(), '.tspr', 'db.sqlite');
  const extraAllowedPaths = opts?.extraAllowedPaths ?? [];

  // Load static assets at startup (fail fast if missing)
  const cssContent = readUiFile('style.css');
  const jsContent = readUiFile('app.js');
  const indexTemplate = readUiFile('index.html');
  const runTemplate = readUiFile('run.html');
  const compareTemplate = readUiFile('compare.html');
  const costTemplate = readUiFile('cost.html');

  const db = await openSqlite(dbFilePath);

  const handler = makeHandler(
    db,
    cssContent,
    jsContent,
    indexTemplate,
    runTemplate,
    compareTemplate,
    costTemplate,
    extraAllowedPaths,
  );
  const server = http.createServer(handler);

  await new Promise<void>((resolve, reject) => {
    server.listen(port, host, () => resolve());
    server.once('error', reject);
  });

  const url = `http://${host}:${port}`;

  if (shouldOpen) {
    openBrowser(url);
  }

  return {
    url,
    close: (): Promise<void> => {
      return new Promise<void>((resolve, reject) => {
        db.close();
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}

// Export helpers for testing
export { isPathAllowed, buildAllowlist };
