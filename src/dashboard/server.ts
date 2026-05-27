/**
 * src/dashboard/server.ts
 *
 * Local HTTP dashboard server for tspr. Zero external deps — uses only
 * node:http, node:fs, node:path, node:os, node:url.
 *
 * Routes:
 *   GET /                        → index.html with {{RUNS_JSON}} substituted
 *   GET /api/runs                → JSON array of runs (newest first)
 *   GET /api/runs/:runId         → JSON single run + test_results
 *   GET /runs/:runId             → run.html with run detail substituted
 *   GET /style.css               → dashboard CSS
 *   GET /app.js                  → dashboard JS
 *   GET /artifacts/:runId/:file  → static file from ~/.tspr/runs/<runId>/<file>
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

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
}

export interface DashboardHandle {
  url: string;
  close: () => Promise<void>;
}

// ─── SQLite shape (server.ts schema — integer PK) ────────────────────────────

interface RunRow {
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

interface TestResultRow {
  id: number;
  run_id: number;
  test_id: string;
  title: string | null;
  outcome: string | null;
  stack: string | null;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(__dirname, 'ui');

function readUiFile(name: string): string {
  return fs.readFileSync(path.join(UI_DIR, name), 'utf-8');
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pillClass(status: string): string {
  const map: Record<string, string> = {
    ok: 'pill--ok',
    partial: 'pill--partial',
    failed: 'pill--failed',
    'all-failed': 'pill--all-failed',
    error: 'pill--error',
    'in-progress': 'pill--in-progress',
  };
  return map[status] ?? 'pill--in-progress';
}

function pillText(status: string): string {
  const map: Record<string, string> = {
    ok: '✓ ok',
    partial: '⚠ partial',
    failed: '✗ failed',
    'all-failed': '✗ all-failed',
    error: '✗ error',
    'in-progress': '⟳ running',
  };
  return map[status] ?? status;
}

function projectLabel(projectPath: string | null | undefined): string {
  if (!projectPath) return '—';
  const parts = projectPath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] ?? projectPath;
}

function formatMs(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const delta = (Date.now() - new Date(iso).getTime()) / 1000;
  if (delta < 60) return `${Math.round(delta)}s ago`;
  if (delta < 3600) return `${Math.round(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.round(delta / 3600)}h ago`;
  return `${Math.round(delta / 86400)}d ago`;
}

// ─── SQLite read-only helpers ─────────────────────────────────────────────────

/**
 * Open SQLite with better-sqlite3 (already in deps).
 * Returns a thin interface; we import dynamically to allow the module to load
 * even when better-sqlite3 is not present (test environments with :memory: mock).
 */
async function openSqlite(dbFilePath: string): Promise<{
  getRuns: () => RunRow[];
  getRun: (id: number) => RunRow | undefined;
  getTestResults: (runId: number) => TestResultRow[];
  close: () => void;
}> {
  // Dynamic import so TS compiles without hard dep coupling
  const { default: Database } = await import('better-sqlite3') as { default: typeof import('better-sqlite3') };

  if (!fs.existsSync(dbFilePath)) {
    // Return empty stub — no data yet
    return {
      getRuns: () => [],
      getRun: () => undefined,
      getTestResults: () => [],
      close: () => undefined,
    };
  }

  const db = new Database(dbFilePath, { readonly: true, fileMustExist: true });
  // WAL pragma is a no-op on readonly connections — skip it

  return {
    getRuns(): RunRow[] {
      try {
        return db.prepare<[], RunRow>(
          `SELECT * FROM runs ORDER BY id DESC LIMIT 500`,
        ).all();
      } catch {
        return [];
      }
    },
    getRun(id: number): RunRow | undefined {
      try {
        return db.prepare<[number], RunRow>(`SELECT * FROM runs WHERE id = ?`).get(id);
      } catch {
        return undefined;
      }
    },
    getTestResults(runId: number): TestResultRow[] {
      try {
        return db.prepare<[number], TestResultRow>(
          `SELECT * FROM test_results WHERE run_id = ?`,
        ).all(runId);
      } catch {
        return [];
      }
    },
    close(): void {
      try { db.close(); } catch { /* ignore */ }
    },
  };
}

// ─── Render helpers ───────────────────────────────────────────────────────────

function renderRunsRows(runs: RunRow[]): string {
  if (runs.length === 0) {
    return `<tr><td colspan="7">
      <div class="empty">
        <div class="empty__icon">📭</div>
        <div class="empty__msg">No runs yet</div>
        <div class="empty__sub">Runs appear here after you call a tspr MCP tool.</div>
      </div>
    </td></tr>`;
  }

  return runs.map((r) => {
    const status = (r.outcome ?? 'in-progress').toLowerCase();
    const runId = String(r.id);
    const displayId = runId.length > 16 ? runId.slice(0, 16) + '…' : runId;
    return `<tr onclick="location.href='/runs/${encodeURIComponent(runId)}'">
      <td><span class="run-id" title="${escHtml(runId)}">${escHtml(displayId)}</span></td>
      <td><span class="project-name">${escHtml(projectLabel(null))}</span></td>
      <td><span class="pill ${pillClass(status)}">${pillText(status)}</span></td>
      <td class="stats">${escHtml(r.tool.replace('tspr_', '').replace(/_/g, ' '))}</td>
      <td class="time-cell">${escHtml(relativeTime(r.started_at))}</td>
      <td class="time-cell">${escHtml(formatMs(r.duration_ms))}</td>
      <td class="time-cell">${escHtml(r.error_code ?? '')}</td>
    </tr>`;
  }).join('\n');
}

function renderRunDetail(
  run: RunRow,
  testResults: TestResultRow[],
  executeResult: ExecuteResultShape | null,
): string {
  const status = (run.outcome ?? 'in-progress').toLowerCase();
  const runId = String(run.id);
  const project = projectLabel(null);

  // Status pill HTML
  const statusPill = `<span class="pill ${pillClass(status)}">${pillText(status)}</span>`;

  // Tool label
  const toolLabel = run.tool.replace('tspr_', '').replace(/_/g, ' ');

  // Duration
  const duration = formatMs(run.duration_ms);

  // Error code meta (optional)
  const errorCodeMeta = run.error_code
    ? `<div class="meta-pair"><span>Error code</span><strong style="color:var(--red)">${escHtml(run.error_code)}</strong></div>`
    : '';

  // Stats bar — use executeResult if available, else derive from test_results rows
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let total = 0;

  if (executeResult) {
    passed = executeResult.passed;
    failed = executeResult.failed;
    skipped = executeResult.skipped;
    total = executeResult.totalTests;
  } else if (testResults.length > 0) {
    for (const t of testResults) {
      const o = (t.outcome ?? '').toLowerCase();
      if (o === 'passed') passed++;
      else if (o === 'failed') failed++;
      else skipped++;
    }
    total = testResults.length;
  }

  const statsBar = total > 0
    ? `<div class="stats-bar">
        <div class="stat-card stat-card--total"><div class="stat-card__num">${total}</div><div class="stat-card__label">Total</div></div>
        <div class="stat-card stat-card--ok"><div class="stat-card__num">${passed}</div><div class="stat-card__label">Passed</div></div>
        <div class="stat-card stat-card--fail"><div class="stat-card__num">${failed}</div><div class="stat-card__label">Failed</div></div>
        <div class="stat-card stat-card--skip"><div class="stat-card__num">${skipped}</div><div class="stat-card__label">Skipped</div></div>
      </div>`
    : '';

  // Warnings
  const warnings = executeResult?.warnings ?? [];
  const warningsSection = warnings.length > 0
    ? `<ul class="warning-list">${warnings.map((w) => `<li class="warning-item"><span>⚠</span>${escHtml(w)}</li>`).join('')}</ul>`
    : '';

  // Failures
  const failures = executeResult?.failures ?? testResults.filter((t) => (t.outcome ?? '') === 'failed').map((t) => ({
    testId: t.test_id,
    title: t.title ?? t.test_id,
    stack: t.stack ?? '',
    suggestedFixRegion: null as null,
  }));

  const passedTests = testResults.filter((t) => (t.outcome ?? '') === 'passed');
  const skippedTests = testResults.filter((t) => (t.outcome ?? '') !== 'passed' && (t.outcome ?? '') !== 'failed');

  let testResultsSection = '';
  if (failures.length > 0) {
    const failureCards = failures.map((f, i) => {
      const fix = f.suggestedFixRegion;
      const fixHtml = fix
        ? `<div class="fix-region"><strong>Suggested fix:</strong> ${escHtml(fix.file)} L${fix.lineStart}–${fix.lineEnd} — ${escHtml(fix.why)}</div>`
        : '';
      return `<div class="failure-card" id="failure-${i}">
        <div class="failure-card__header">
          <span class="pill pill--failed" style="flex-shrink:0">✗</span>
          <span class="failure-card__title">${escHtml(f.title)}</span>
          <svg class="failure-card__chevron" width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M5 2l5 5-5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <div class="failure-card__body">
          <pre class="failure-stack">${escHtml(f.stack)}</pre>
          ${fixHtml}
        </div>
      </div>`;
    }).join('\n');

    testResultsSection += `<div class="section">
      <div class="section-title">Failures (${failures.length})</div>
      <div class="failure-list">${failureCards}</div>
    </div>`;
  }

  if (passedTests.length > 0) {
    const items = passedTests.map((t) =>
      `<div class="test-item test-item--passed"><span class="pill pill--ok" style="flex-shrink:0">✓</span>${escHtml(t.title ?? t.test_id)}</div>`
    ).join('\n');
    testResultsSection += `<div class="section">
      <div class="section-title">Passed (${passedTests.length})</div>
      <div class="test-list">${items}</div>
    </div>`;
  }

  if (skippedTests.length > 0) {
    const items = skippedTests.map((t) =>
      `<div class="test-item test-item--skipped"><span class="pill pill--skipped" style="flex-shrink:0">—</span>${escHtml(t.title ?? t.test_id)}</div>`
    ).join('\n');
    testResultsSection += `<div class="section">
      <div class="section-title">Skipped (${skippedTests.length})</div>
      <div class="test-list">${items}</div>
    </div>`;
  }

  // Raw JSON
  const rawJson = JSON.stringify({ run, testResults, executeResult }, null, 2);

  return {
    RUN_ID: runId,
    RUN_STATUS: status,
    PROJECT_NAME: escHtml(project),
    STATUS_PILL: statusPill,
    TOOL_LABEL: escHtml(toolLabel),
    STARTED_AT: escHtml(run.started_at),
    DURATION: escHtml(duration),
    ERROR_CODE_META: errorCodeMeta,
    STATS_BAR: statsBar,
    WARNINGS_SECTION: warningsSection,
    TEST_RESULTS_SECTION: testResultsSection,
    RAW_JSON: escHtml(rawJson),
  } as unknown as string; // cast — see applyTemplate usage
}

type RunDetailTemplateVars = {
  RUN_ID: string;
  RUN_STATUS: string;
  PROJECT_NAME: string;
  STATUS_PILL: string;
  TOOL_LABEL: string;
  STARTED_AT: string;
  DURATION: string;
  ERROR_CODE_META: string;
  STATS_BAR: string;
  WARNINGS_SECTION: string;
  TEST_RESULTS_SECTION: string;
  RAW_JSON: string;
};

function applyTemplate(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    // Replace all occurrences of {{KEY}}
    result = result.split(`{{${key}}}`).join(value);
  }
  return result;
}

// ExecuteResult shape (from generateAndExecute.ts) — used when reading .tspr/test_results.json
interface ExecuteResultShape {
  status: string;
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
  warnings: string[];
  failures: Array<{
    testId: string;
    title: string;
    stack: string;
    suggestedFixRegion: {
      file: string;
      lineStart: number;
      lineEnd: number;
      why: string;
    } | null;
  }>;
}

function tryReadExecuteResult(projectPath: string | null): ExecuteResultShape | null {
  if (!projectPath) return null;
  const p = path.join(projectPath, '.tspr', 'test_results.json');
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    return JSON.parse(raw) as ExecuteResultShape;
  } catch {
    return null;
  }
}

// ─── HTTP handler ─────────────────────────────────────────────────────────────

function send(
  res: http.ServerResponse,
  status: number,
  contentType: string,
  body: string | Buffer,
): void {
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

type DbHandle = Awaited<ReturnType<typeof openSqlite>>;

function makeHandler(db: DbHandle, cssContent: string, jsContent: string, indexTemplate: string, runTemplate: string) {
  return function handler(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';

    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    // ── Static assets ──────────────────────────────────────────────────────
    if (url === '/style.css') {
      send(res, 200, 'text/css; charset=utf-8', cssContent);
      return;
    }

    if (url === '/app.js') {
      send(res, 200, 'application/javascript; charset=utf-8', jsContent);
      return;
    }

    // ── /api/runs ──────────────────────────────────────────────────────────
    if (url === '/api/runs' || url === '/api/runs/') {
      const runs = db.getRuns();
      sendJson(res, 200, runs);
      return;
    }

    // ── /api/runs/:runId ───────────────────────────────────────────────────
    const apiRunMatch = url.match(/^\/api\/runs\/([^/?]+)(\?.*)?$/);
    if (apiRunMatch) {
      const runId = decodeURIComponent(apiRunMatch[1]);
      const id = parseInt(runId, 10);
      if (isNaN(id)) {
        sendNotFound(res, `Invalid run id: ${runId}`);
        return;
      }
      const run = db.getRun(id);
      if (!run) {
        sendNotFound(res, `Run ${runId} not found`);
        return;
      }
      const testResults = db.getTestResults(id);
      sendJson(res, 200, { run, testResults });
      return;
    }

    // ── /runs/:runId ───────────────────────────────────────────────────────
    const runPageMatch = url.match(/^\/runs\/([^/?]+)(\?.*)?$/);
    if (runPageMatch) {
      const runId = decodeURIComponent(runPageMatch[1]);
      const id = parseInt(runId, 10);
      if (isNaN(id)) {
        sendNotFound(res, `Invalid run id: ${runId}`);
        return;
      }
      const run = db.getRun(id);
      if (!run) {
        sendNotFound(res, `Run ${runId} not found`);
        return;
      }
      const testResults = db.getTestResults(id);
      const executeResult = tryReadExecuteResult(null); // project path not stored on run row in this schema
      const vars = renderRunDetail(run, testResults, executeResult) as unknown as RunDetailTemplateVars;
      const html = applyTemplate(runTemplate, vars as unknown as Record<string, string>);
      sendHtml(res, html);
      return;
    }

    // ── /artifacts/:runId/:file ────────────────────────────────────────────
    const artifactMatch = url.match(/^\/artifacts\/([^/]+)\/(.+)$/);
    if (artifactMatch) {
      const runId = decodeURIComponent(artifactMatch[1]);
      const fileName = decodeURIComponent(artifactMatch[2]);
      // Sanitize: no path traversal
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
    if (url === '/' || url === '/index.html') {
      const runs = db.getRuns();
      const runsRows = renderRunsRows(runs);
      const html = applyTemplate(indexTemplate, {
        RUNS_JSON: JSON.stringify(runs),
        RUNS_ROWS: runsRows,
      });
      sendHtml(res, html);
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
    // Best-effort — ignore if open fails
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Start the tspr local web dashboard server.
 *
 * @returns Promise resolving to { url, close } once server is listening.
 */
export async function startDashboard(opts?: DashboardOptions): Promise<DashboardHandle> {
  const port = opts?.port ?? 7654;
  const host = opts?.host ?? '127.0.0.1';
  const shouldOpen = opts?.open ?? true;
  const dbFilePath = opts?.dbPath ?? path.join(os.homedir(), '.tspr', 'db.sqlite');

  // Load static assets at startup (fail fast if missing)
  const cssContent = readUiFile('style.css');
  const jsContent = readUiFile('app.js');
  const indexTemplate = readUiFile('index.html');
  const runTemplate = readUiFile('run.html');

  // Open SQLite (read-only; stub if DB missing)
  const db = await openSqlite(dbFilePath);

  const handler = makeHandler(db, cssContent, jsContent, indexTemplate, runTemplate);
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
