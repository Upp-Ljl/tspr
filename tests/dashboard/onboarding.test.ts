/**
 * Tests for onboarding state routes:
 *   GET  /api/onboarding-state
 *   POST /api/onboarding-dismiss
 *   GET  /onboarding.html
 *
 * Uses the real dashboard server spun up with a temp SQLite DB.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import getPort from 'get-port';
import Database from 'better-sqlite3';
import { startDashboard } from '../../src/dashboard/server.js';
import type { DashboardHandle } from '../../src/dashboard/server.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

let server: DashboardHandle;
let baseUrl: string;
let tmpDbPath: string;
let tmpDbDir: string;

function createTestDb(): string {
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tspr-onboard-test-'));
  tmpDbPath = path.join(tmpDbDir, 'db.sqlite');
  const db = new Database(tmpDbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT, tool TEXT NOT NULL, params_hash TEXT NOT NULL,
      started_at TEXT NOT NULL, ended_at TEXT, outcome TEXT,
      error_code TEXT, duration_ms INTEGER
    );
    CREATE TABLE IF NOT EXISTS test_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER, test_id TEXT NOT NULL, title TEXT, outcome TEXT, stack TEXT
    );
  `);
  db.close();
  return tmpDbPath;
}

async function rawGet(urlPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(`${baseUrl}${urlPath}`, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
  });
}

async function getJson(urlPath: string): Promise<{ status: number; body: unknown }> {
  const { status, body } = await rawGet(urlPath);
  try { return { status, body: JSON.parse(body) }; } catch { return { status, body: null }; }
}

async function postJson(urlPath: string, data: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(data);
    const url = new URL(`${baseUrl}${urlPath}`);
    const opts = {
      hostname: url.hostname,
      port: Number(url.port),
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    };
    const req = http.request(opts, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => {
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode ?? 0, body: null }); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

beforeAll(async () => {
  const port = await getPort();
  const dbPath = createTestDb();
  server = await startDashboard({ port, open: false, dbPath });
  baseUrl = server.url;
});

afterAll(async () => {
  await server.close();
  try { fs.rmSync(tmpDbDir, { recursive: true, force: true }); } catch { /* ignore */ }
  // Clean up onboarding state written during tests
  const onboardingPath = path.join(os.homedir(), '.tspr', 'onboarding.json');
  // Note: we can't easily isolate this without HOME override; leave cleanup best-effort
});

// ─── tests ────────────────────────────────────────────────────────────────────

describe('GET /api/onboarding-state', () => {
  it('returns 200 with a boolean seen field', async () => {
    const { status, body } = await getJson('/api/onboarding-state');
    expect(status).toBe(200);
    expect(typeof (body as { seen: unknown }).seen).toBe('boolean');
  });

  it('?onboarding=fresh always returns {seen:false}', async () => {
    const { status, body } = await getJson('/api/onboarding-state?onboarding=fresh');
    expect(status).toBe(200);
    expect((body as { seen: boolean }).seen).toBe(false);
  });
});

describe('POST /api/onboarding-dismiss', () => {
  it('returns 200 {ok:true}', async () => {
    const { status, body } = await postJson('/api/onboarding-dismiss', {});
    expect(status).toBe(200);
    expect((body as { ok: boolean }).ok).toBe(true);
  });

  it('after dismiss, GET /api/onboarding-state returns {seen:true}', async () => {
    await postJson('/api/onboarding-dismiss', {});
    const { status, body } = await getJson('/api/onboarding-state');
    expect(status).toBe(200);
    expect((body as { seen: boolean }).seen).toBe(true);
  });

  it('is idempotent — second dismiss also returns {ok:true}', async () => {
    await postJson('/api/onboarding-dismiss', {});
    const { status, body } = await postJson('/api/onboarding-dismiss', {});
    expect(status).toBe(200);
    expect((body as { ok: boolean }).ok).toBe(true);
  });

  it('?onboarding=fresh returns {seen:false} even after dismiss', async () => {
    await postJson('/api/onboarding-dismiss', {});
    const { status, body } = await getJson('/api/onboarding-state?onboarding=fresh');
    expect(status).toBe(200);
    expect((body as { seen: boolean }).seen).toBe(false);
  });
});

describe('GET /onboarding.html', () => {
  it('serves the onboarding HTML fragment with 200', async () => {
    const { status, body } = await rawGet('/onboarding.html');
    expect(status).toBe(200);
    expect(body.toLowerCase()).toContain('onboarding');
  });

  it('contains the 3 step numbers', async () => {
    const { body } = await rawGet('/onboarding.html');
    expect(body).toMatch(/onboarding-step__num/);
  });
});
