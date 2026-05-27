/**
 * tests/dashboard/server.test.ts
 *
 * Tests for the tspr local web dashboard server.
 * Uses an in-memory SQLite DB to avoid requiring ~/.tspr/db.sqlite.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import getPort from 'get-port';
import Database from 'better-sqlite3';
import { startDashboard } from '../../src/dashboard/server.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

async function get(url: string): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          body,
          headers: res.headers as Record<string, string | string[] | undefined>,
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(new Error('timeout')); });
  });
}

// ─── test db fixture ──────────────────────────────────────────────────────────

let tmpDbPath: string;
let tmpDbDir: string;

function createTestDb(): string {
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tspr-test-'));
  tmpDbPath = path.join(tmpDbDir, 'db.sqlite');

  const db = new Database(tmpDbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT,
      tool        TEXT NOT NULL,
      params_hash TEXT NOT NULL,
      started_at  TEXT NOT NULL,
      ended_at    TEXT,
      outcome     TEXT,
      error_code  TEXT,
      duration_ms INTEGER
    );

    CREATE TABLE IF NOT EXISTS test_results (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id   INTEGER,
      test_id  TEXT NOT NULL,
      title    TEXT,
      outcome  TEXT,
      stack    TEXT
    );
  `);

  // Insert 3 test runs
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO runs (tool, params_hash, started_at, ended_at, outcome, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('tspr_generate_code_and_execute', 'abc123', now, now, 'ok', 1500);

  db.prepare(
    `INSERT INTO runs (tool, params_hash, started_at, ended_at, outcome, duration_ms, error_code)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('tspr_bootstrap_tests', 'def456', now, now, 'error', 300, 'ERR_DOCKER_UNAVAILABLE');

  db.prepare(
    `INSERT INTO runs (tool, params_hash, started_at, outcome)
     VALUES (?, ?, ?, ?)`,
  ).run('tspr_generate_frontend_test_plan', 'ghi789', now, 'in-progress');

  // Insert test_results for run 1
  db.prepare(
    `INSERT INTO test_results (run_id, test_id, title, outcome, stack)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(1, 'test-1', 'should render home page', 'passed', null);

  db.prepare(
    `INSERT INTO test_results (run_id, test_id, title, outcome, stack)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(1, 'test-2', 'should return 404 on missing route', 'failed', 'AssertionError: expected 404');

  db.close();
  return tmpDbPath;
}

// ─── suite ────────────────────────────────────────────────────────────────────

describe('dashboard server', () => {
  let handle: { url: string; close: () => Promise<void> };
  let baseUrl: string;

  beforeAll(async () => {
    const dbPath = createTestDb();
    const port = await getPort();
    handle = await startDashboard({ port, open: false, dbPath });
    baseUrl = handle.url;
  });

  afterAll(async () => {
    await handle.close();
    // Cleanup temp db
    try { fs.rmSync(tmpDbDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ── test 1: home page returns 200 HTML ──────────────────────────────────────
  it('GET / returns 200 with HTML', async () => {
    const res = await get(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('<!DOCTYPE html>');
    expect(res.body).toContain('tspr');
  });

  // ── test 2: CSS returns 200 with text/css ────────────────────────────────────
  it('GET /style.css returns 200 with text/css', async () => {
    const res = await get(`${baseUrl}/style.css`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/css/);
    expect(res.body.length).toBeGreaterThan(100);
  });

  // ── test 3: JS returns 200 ───────────────────────────────────────────────────
  it('GET /app.js returns 200 with JavaScript', async () => {
    const res = await get(`${baseUrl}/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
  });

  // ── test 4: /api/runs returns array ─────────────────────────────────────────
  it('GET /api/runs returns 200 with JSON array', async () => {
    const res = await get(`${baseUrl}/api/runs`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    const data = JSON.parse(res.body);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(3);
    // Newest first (highest id first)
    // id may be numeric or string depending on schema; just verify order via started_at or id
    expect(Number(data[0].id)).toBeGreaterThanOrEqual(Number(data[data.length - 1].id));
  });

  // ── test 5: /api/runs/:id returns single run ─────────────────────────────────
  it('GET /api/runs/1 returns run with testResults', async () => {
    const res = await get(`${baseUrl}/api/runs/1`);
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.run).toBeDefined();
    expect(String(data.run.id)).toBe('1');
    expect(data.run.tool).toBe('tspr_generate_code_and_execute');
    expect(Array.isArray(data.testResults)).toBe(true);
    expect(data.testResults.length).toBe(2);
  });

  // ── test 6: /api/runs/:nonexistent returns 404 ──────────────────────────────
  it('GET /api/runs/99999 returns 404', async () => {
    const res = await get(`${baseUrl}/api/runs/99999`);
    expect(res.status).toBe(404);
    const data = JSON.parse(res.body);
    expect(data.error).toBeDefined();
  });

  // ── test 7: /runs/:id returns run detail HTML ────────────────────────────────
  it('GET /runs/1 returns 200 HTML with run detail', async () => {
    const res = await get(`${baseUrl}/runs/1`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('Run #1');
    expect(res.body).toContain('tspr');
  });

  // ── test 8: /runs/:nonexistent returns 404 ──────────────────────────────────
  it('GET /runs/99999 returns 404', async () => {
    const res = await get(`${baseUrl}/runs/99999`);
    expect(res.status).toBe(404);
  });

  // ── test 9: server closes cleanly ───────────────────────────────────────────
  it('server closes without error', async () => {
    // This is validated by afterAll() — if close() throws, the suite fails.
    // We do an extra check: after close is called in afterAll, this test just
    // verifies the URL was set.
    expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
  });
});

// ── test 10: no DB file → empty runs array ────────────────────────────────────
describe('dashboard server — missing db', () => {
  let handle: { url: string; close: () => Promise<void> };

  beforeAll(async () => {
    const port = await getPort();
    const nonexistentDb = path.join(os.tmpdir(), 'tspr-nonexistent-' + Date.now() + '.sqlite');
    handle = await startDashboard({ port, open: false, dbPath: nonexistentDb });
  });

  afterAll(async () => {
    await handle.close();
  });

  it('GET /api/runs returns empty array when DB missing', async () => {
    const res = await get(`${handle.url}/api/runs`);
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(0);
  });
});
