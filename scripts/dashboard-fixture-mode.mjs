#!/usr/bin/env node
/**
 * scripts/dashboard-fixture-mode.mjs
 *
 * Starts the tspr dashboard with synthetic fixture data:
 * - 3 fake projects (meme-weather, demo-app, fixture-x)
 * - 12 fake runs spread over last 14 days, mix of pass/fail/partial
 * - 5 fake failures with realistic suggestedFixRegion + suggestedPatch
 * - 1 project with declining trend, 1 improving, 1 flat
 *
 * Usage:
 *   npm run build && node scripts/dashboard-fixture-mode.mjs
 *   PORT=8080 node scripts/dashboard-fixture-mode.mjs
 *
 * Ctrl+C to stop.
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

// ─── Fixture DB ───────────────────────────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tspr-fixture-'));
const dbPath = path.join(tmpDir, 'db.sqlite');

const db = new Database(dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS runs (
    id            TEXT PRIMARY KEY,
    tool_name     TEXT NOT NULL,
    project_path  TEXT,
    started_at    TEXT NOT NULL,
    completed_at  TEXT,
    status        TEXT NOT NULL DEFAULT 'in-progress',
    error_code    TEXT
  );
  CREATE TABLE IF NOT EXISTS test_results (
    id              TEXT PRIMARY KEY,
    run_id          TEXT NOT NULL,
    test_id         TEXT NOT NULL,
    test_name       TEXT NOT NULL,
    test_file       TEXT NOT NULL,
    test_type       TEXT NOT NULL,
    status          TEXT NOT NULL,
    error_message   TEXT,
    duration_ms     INTEGER,
    suggested_fix_region TEXT,
    suggested_patch TEXT,
    created_at      TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id                TEXT PRIMARY KEY,
    project_path      TEXT NOT NULL,
    local_port        INTEGER NOT NULL DEFAULT 5173,
    type              TEXT NOT NULL,
    test_scope        TEXT NOT NULL,
    detected_framework TEXT NOT NULL DEFAULT '',
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
  );
`);

// Project paths (fake but plausible)
const PROJECTS = {
  'meme-weather': '/Users/dev/projects/meme-weather',
  'demo-app':     '/Users/dev/projects/demo-app',
  'fixture-x':   '/Users/dev/projects/fixture-x',
};

// Helper: date N days ago
function daysAgo(n, hoursOffset = 0) {
  const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000 - hoursOffset * 60 * 60 * 1000);
  return d.toISOString();
}

// Helper: simple ID
let idSeq = 0;
function nextId() { return 'run-' + String(++idSeq).padStart(4, '0'); }
function testId() { return 'tr-' + String(++idSeq).padStart(5, '0'); }

const TOOLS = ['tspr_generate_code_and_execute', 'tspr_bootstrap_tests', 'tspr_generate_backend_test_plan'];

// Fixture failures with realistic patch
const FIXTURE_FAILURES = [
  {
    testId: 'api-get-memes-200',
    testName: 'GET /api/memes should return 200 OK',
    testFile: `${PROJECTS['meme-weather']}/tests/meme-weather.spec.ts`,
    errorMessage: 'AssertionError: expected 500 to deeply equal 200\n    at meme-weather.spec.ts:12:18\n    at processTicksAndRejections',
    suggestedFixRegion: JSON.stringify({
      file: `${PROJECTS['meme-weather']}/src/app.ts`,
      lineStart: 42,
      lineEnd: 58,
      why: 'The /api/memes handler throws an unhandled error when the meme service is unavailable. Add a try/catch and return a 200 with empty array as fallback.',
    }),
    suggestedPatch: `--- a/src/app.ts
+++ b/src/app.ts
@@ -42,8 +42,14 @@
 app.get('/api/memes', async (req, res) => {
-  const memes = await memeService.getAll();
-  res.json(memes);
+  try {
+    const memes = await memeService.getAll();
+    res.json(memes);
+  } catch (err) {
+    logger.warn('meme service unavailable', err);
+    res.json([]);
+  }
 });`,
  },
  {
    testId: 'api-settle-week-200',
    testName: 'GET /api/settle/:week returns settlement data',
    testFile: `${PROJECTS['meme-weather']}/tests/settle.spec.ts`,
    errorMessage: 'AssertionError: expected 404 to equal 200\n    at settle.spec.ts:46:31',
    suggestedFixRegion: JSON.stringify({
      file: `${PROJECTS['meme-weather']}/src/routes/settle.ts`,
      lineStart: 10,
      lineEnd: 25,
      why: 'Route /api/settle/:week is not registered. Add it to the express router.',
    }),
    suggestedPatch: `--- a/src/routes/settle.ts
+++ b/src/routes/settle.ts
@@ -10,0 +11,10 @@
+router.get('/settle/:week', async (req, res) => {
+  const { week } = req.params;
+  const data = await db.getSettlementByWeek(week);
+  if (!data) {
+    return res.status(404).json({ error: 'Week not found' });
+  }
+  res.json(data);
+});
+
+export default router;`,
  },
  {
    testId: 'auth-login-redirect',
    testName: 'POST /auth/login redirects to dashboard',
    testFile: `${PROJECTS['demo-app']}/tests/auth.spec.ts`,
    errorMessage: 'TimeoutError: waiting for selector ".dashboard-header" exceeded 10s',
    suggestedFixRegion: JSON.stringify({
      file: `${PROJECTS['demo-app']}/src/auth/login.ts`,
      lineStart: 33,
      lineEnd: 45,
      why: 'After successful login, redirect target is "/" not "/dashboard". Update the redirect URL.',
    }),
    suggestedPatch: `--- a/src/auth/login.ts
+++ b/src/auth/login.ts
@@ -38,1 +38,1 @@
-  res.redirect('/');
+  res.redirect('/dashboard');`,
  },
  {
    testId: 'fixture-x-unit-calc',
    testName: 'calculateTotal returns correct sum',
    testFile: `${PROJECTS['fixture-x']}/tests/calc.test.ts`,
    errorMessage: 'AssertionError: expected 42 to equal 43\n    at calc.test.ts:8:3',
    suggestedFixRegion: JSON.stringify({
      file: `${PROJECTS['fixture-x']}/src/calc.ts`,
      lineStart: 5,
      lineEnd: 12,
      why: 'Off-by-one: the loop uses < instead of <=, missing the last element.',
    }),
    suggestedPatch: `--- a/src/calc.ts
+++ b/src/calc.ts
@@ -7,1 +7,1 @@
-  for (let i = 0; i < items.length; i++) {
+  for (let i = 0; i <= items.length - 1; i++) {`,
  },
  {
    testId: 'fixture-x-db-connect',
    testName: 'Database connection succeeds',
    testFile: `${PROJECTS['fixture-x']}/tests/db.test.ts`,
    errorMessage: 'Error: connect ECONNREFUSED 127.0.0.1:5432\n    at TCPConnectWrap.afterConnect',
    suggestedFixRegion: JSON.stringify({
      file: `${PROJECTS['fixture-x']}/src/db.ts`,
      lineStart: 1,
      lineEnd: 20,
      why: 'The DB URL defaults to a hardcoded port. Read from DATABASE_URL env var with a fallback to sqlite in test environments.',
    }),
    suggestedPatch: null,
  },
];

const insertRun = db.prepare(`INSERT INTO runs (id, tool_name, project_path, started_at, completed_at, status, error_code) VALUES (?, ?, ?, ?, ?, ?, ?)`);
const insertResult = db.prepare(`INSERT INTO test_results (id, run_id, test_id, test_name, test_file, test_type, status, error_message, duration_ms, suggested_fix_region, suggested_patch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

// ─── meme-weather: declining trend (was healthy, now broken) ────────────────
// Runs: day 14, 12, 10, 8 — progressively worse
const mwProject = PROJECTS['meme-weather'];
{
  // Run 1 (14d ago): 5/5 passing (healthy)
  const r1 = nextId();
  insertRun.run(r1, TOOLS[0], mwProject, daysAgo(14), daysAgo(14, -2), 'ok', null);
  ['should render home page', 'should load radar', 'should fetch memes', 'should authenticate user', 'should load archived content'].forEach((name, i) => {
    insertResult.run(testId(), r1, 'mw-' + i, name, `${mwProject}/tests/meme-weather.spec.ts`, 'backend-integration', 'passed', null, 800 + i * 100, null, null, daysAgo(14));
  });

  // Run 2 (10d ago): 4/5 (one failure creeping in)
  const r2 = nextId();
  insertRun.run(r2, TOOLS[0], mwProject, daysAgo(10), daysAgo(10, -3), 'ok', null);
  ['should render home page', 'should load radar', 'should fetch memes', 'should authenticate user'].forEach((name, i) => {
    insertResult.run(testId(), r2, 'mw-' + i, name, `${mwProject}/tests/meme-weather.spec.ts`, 'backend-integration', 'passed', null, 850 + i * 100, null, null, daysAgo(10));
  });
  insertResult.run(testId(), r2, 'api-get-memes-200', FIXTURE_FAILURES[0].testName, FIXTURE_FAILURES[0].testFile, 'backend-integration', 'failed', FIXTURE_FAILURES[0].errorMessage, null, FIXTURE_FAILURES[0].suggestedFixRegion, FIXTURE_FAILURES[0].suggestedPatch, daysAgo(10));

  // Run 3 (5d ago): 3/5 (two failures now)
  const r3 = nextId();
  insertRun.run(r3, TOOLS[0], mwProject, daysAgo(5), daysAgo(5, -3), 'ok', null);
  ['should render home page', 'should load radar', 'should authenticate user'].forEach((name, i) => {
    insertResult.run(testId(), r3, 'mw-' + i, name, `${mwProject}/tests/meme-weather.spec.ts`, 'backend-integration', 'passed', null, 900, null, null, daysAgo(5));
  });
  insertResult.run(testId(), r3, 'api-get-memes-200', FIXTURE_FAILURES[0].testName, FIXTURE_FAILURES[0].testFile, 'backend-integration', 'failed', FIXTURE_FAILURES[0].errorMessage, null, FIXTURE_FAILURES[0].suggestedFixRegion, FIXTURE_FAILURES[0].suggestedPatch, daysAgo(5));
  insertResult.run(testId(), r3, 'api-settle-week-200', FIXTURE_FAILURES[1].testName, FIXTURE_FAILURES[1].testFile, 'backend-integration', 'failed', FIXTURE_FAILURES[1].errorMessage, null, FIXTURE_FAILURES[1].suggestedFixRegion, FIXTURE_FAILURES[1].suggestedPatch, daysAgo(5));

  // Run 4 (1d ago): 3/5 (same two failures)
  const r4 = nextId();
  insertRun.run(r4, TOOLS[0], mwProject, daysAgo(1), daysAgo(1, -3), 'ok', null);
  ['should render home page', 'should load radar', 'should authenticate user'].forEach((name, i) => {
    insertResult.run(testId(), r4, 'mw-' + i, name, `${mwProject}/tests/meme-weather.spec.ts`, 'backend-integration', 'passed', null, 920, null, null, daysAgo(1));
  });
  insertResult.run(testId(), r4, 'api-get-memes-200', FIXTURE_FAILURES[0].testName, FIXTURE_FAILURES[0].testFile, 'backend-integration', 'failed', FIXTURE_FAILURES[0].errorMessage, null, FIXTURE_FAILURES[0].suggestedFixRegion, FIXTURE_FAILURES[0].suggestedPatch, daysAgo(1));
  insertResult.run(testId(), r4, 'api-settle-week-200', FIXTURE_FAILURES[1].testName, FIXTURE_FAILURES[1].testFile, 'backend-integration', 'failed', FIXTURE_FAILURES[1].errorMessage, null, FIXTURE_FAILURES[1].suggestedFixRegion, FIXTURE_FAILURES[1].suggestedPatch, daysAgo(1));
}

// ─── demo-app: improving trend ──────────────────────────────────────────────
const demoProject = PROJECTS['demo-app'];
{
  // Run 1 (13d ago): 2/5 (broken)
  const r1 = nextId();
  insertRun.run(r1, TOOLS[0], demoProject, daysAgo(13), daysAgo(13, -4), 'ok', null);
  ['should render landing page', 'should load navbar'].forEach((name, i) => {
    insertResult.run(testId(), r1, 'da-' + i, name, `${demoProject}/tests/app.spec.ts`, 'frontend-e2e', 'passed', null, 1200, null, null, daysAgo(13));
  });
  ['POST /auth/login redirects to dashboard', 'should display user profile', 'should load settings page'].forEach((name, i) => {
    insertResult.run(testId(), r1, 'da-fail-' + i, name, `${demoProject}/tests/auth.spec.ts`, 'frontend-e2e', 'failed', FIXTURE_FAILURES[2].errorMessage, null, FIXTURE_FAILURES[2].suggestedFixRegion, FIXTURE_FAILURES[2].suggestedPatch, daysAgo(13));
  });

  // Run 2 (9d ago): 3/5 (improving)
  const r2 = nextId();
  insertRun.run(r2, TOOLS[0], demoProject, daysAgo(9), daysAgo(9, -3), 'ok', null);
  ['should render landing page', 'should load navbar', 'should load settings page'].forEach((name, i) => {
    insertResult.run(testId(), r2, 'da-' + i, name, `${demoProject}/tests/app.spec.ts`, 'frontend-e2e', 'passed', null, 1100, null, null, daysAgo(9));
  });
  insertResult.run(testId(), r2, 'auth-login-redirect', FIXTURE_FAILURES[2].testName, FIXTURE_FAILURES[2].testFile, 'frontend-e2e', 'failed', FIXTURE_FAILURES[2].errorMessage, null, FIXTURE_FAILURES[2].suggestedFixRegion, FIXTURE_FAILURES[2].suggestedPatch, daysAgo(9));
  insertResult.run(testId(), r2, 'da-fail-3', 'should display user profile', `${demoProject}/tests/profile.spec.ts`, 'frontend-e2e', 'failed', 'AssertionError: expected .profile-name to exist', null, null, null, daysAgo(9));

  // Run 3 (4d ago): 4/5 (almost there)
  const r3 = nextId();
  insertRun.run(r3, TOOLS[0], demoProject, daysAgo(4), daysAgo(4, -2), 'ok', null);
  ['should render landing page', 'should load navbar', 'should load settings page', 'should display user profile'].forEach((name, i) => {
    insertResult.run(testId(), r3, 'da-' + i, name, `${demoProject}/tests/app.spec.ts`, 'frontend-e2e', 'passed', null, 950, null, null, daysAgo(4));
  });
  insertResult.run(testId(), r3, 'auth-login-redirect', FIXTURE_FAILURES[2].testName, FIXTURE_FAILURES[2].testFile, 'frontend-e2e', 'failed', FIXTURE_FAILURES[2].errorMessage, null, FIXTURE_FAILURES[2].suggestedFixRegion, FIXTURE_FAILURES[2].suggestedPatch, daysAgo(4));

  // Run 4 (6h ago): 5/5 (green!)
  const r4 = nextId();
  insertRun.run(r4, TOOLS[0], demoProject, daysAgo(0, 6), daysAgo(0, 4), 'ok', null);
  ['should render landing page', 'should load navbar', 'should load settings page', 'should display user profile', 'POST /auth/login redirects to dashboard'].forEach((name, i) => {
    insertResult.run(testId(), r4, 'da-' + i, name, `${demoProject}/tests/app.spec.ts`, 'frontend-e2e', 'passed', null, 900, null, null, daysAgo(0, 6));
  });
}

// ─── fixture-x: flat / mixed ─────────────────────────────────────────────────
const fxProject = PROJECTS['fixture-x'];
{
  // 4 runs, alternating pass/partial
  for (let i = 0; i < 4; i++) {
    const daysBack = 12 - i * 3;
    const r = nextId();
    insertRun.run(r, TOOLS[1], fxProject, daysAgo(daysBack), daysAgo(daysBack, -2), 'ok', null);
    ['should initialize config', 'should parse inputs'].forEach((name, j) => {
      insertResult.run(testId(), r, 'fx-pass-' + j + '-' + i, name, `${fxProject}/tests/config.test.ts`, 'backend-integration', 'passed', null, 200, null, null, daysAgo(daysBack));
    });
    insertResult.run(testId(), r, 'fixture-x-unit-calc', FIXTURE_FAILURES[3].testName, FIXTURE_FAILURES[3].testFile, 'backend-integration', 'failed', FIXTURE_FAILURES[3].errorMessage, null, FIXTURE_FAILURES[3].suggestedFixRegion, FIXTURE_FAILURES[3].suggestedPatch, daysAgo(daysBack));
    insertResult.run(testId(), r, 'fixture-x-db-connect', FIXTURE_FAILURES[4].testName, FIXTURE_FAILURES[4].testFile, 'backend-integration', 'failed', FIXTURE_FAILURES[4].errorMessage, null, FIXTURE_FAILURES[4].suggestedFixRegion, FIXTURE_FAILURES[4].suggestedPatch, daysAgo(daysBack));
  }
}

db.close();

// ─── Start dashboard ──────────────────────────────────────────────────────────

const distServerPath = path.join(root, 'dist', 'dashboard', 'server.js');
const distServerUrl = pathToFileURL(distServerPath).href;

let startDashboard;
try {
  const mod = await import(distServerUrl);
  startDashboard = mod.startDashboard;
} catch (err) {
  process.stderr.write(
    `[fixture-mode] Could not load ${distServerPath}\n` +
    `  Run "npm run build" first, then re-run this script.\n` +
    `  Error: ${err.message}\n`,
  );
  process.exit(1);
}

const port = parseInt(process.env.PORT ?? '7654', 10);

process.stdout.write(`[fixture-mode] starting on port ${port} with fixture DB at ${dbPath}\n`);
process.stdout.write(`[fixture-mode] 3 projects: meme-weather (declining), demo-app (improving), fixture-x (flat)\n`);
process.stdout.write(`[fixture-mode] 12 runs, 5 failure types with suggestedPatch\n`);

let handle;
try {
  handle = await startDashboard({ port, open: true, dbPath, extraAllowedPaths: [] });
} catch (err) {
  process.stderr.write(`[fixture-mode] failed to start: ${err.message}\n`);
  // Clean up
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  process.exit(1);
}

process.stdout.write(`[fixture-mode] dashboard running at ${handle.url}\n`);
process.stdout.write(`[fixture-mode] press Ctrl+C to stop\n`);

async function cleanup() {
  process.stdout.write('\n[fixture-mode] shutting down…\n');
  try { await handle.close(); } catch (_) {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  process.stdout.write('[fixture-mode] done\n');
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
