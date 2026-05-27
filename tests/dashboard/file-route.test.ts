/**
 * tests/dashboard/file-route.test.ts
 *
 * Security tests for GET /api/file:
 *  - Returns 403 for paths outside allowlist
 *  - Returns file content for paths inside allowlist
 *  - Handles path traversal attempts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import getPort from 'get-port';
import Database from 'better-sqlite3';
import { startDashboard } from '../../src/dashboard/server.js';

// ─── HTTP helper ──────────────────────────────────────────────────────────────

async function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(new Error('timeout')); });
  });
}

// ─── Setup ────────────────────────────────────────────────────────────────────

let handle: { url: string; close: () => Promise<void> };
let baseUrl: string;
let allowedDir: string;
let allowedFile: string;
let outsideDir: string;
let outsideFile: string;

beforeAll(async () => {
  // Create a temp DB
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tspr-file-test-'));
  const dbPath = path.join(dbDir, 'db.sqlite');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, tool_name TEXT NOT NULL,
      project_path TEXT, started_at TEXT NOT NULL,
      completed_at TEXT, status TEXT NOT NULL DEFAULT 'in-progress', error_code TEXT
    );
    CREATE TABLE IF NOT EXISTS test_results (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, test_id TEXT NOT NULL,
      test_name TEXT NOT NULL, test_file TEXT NOT NULL, test_type TEXT NOT NULL,
      status TEXT NOT NULL, error_message TEXT, duration_ms INTEGER,
      suggested_fix_region TEXT, suggested_patch TEXT, created_at TEXT NOT NULL
    );
  `);
  db.close();

  // Create allowed dir with a test file
  allowedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tspr-allowed-'));
  allowedFile = path.join(allowedDir, 'test.txt');
  fs.writeFileSync(allowedFile, 'hello from allowed file');

  // Create outside dir (separate temp dir NOT in extraAllowedPaths)
  outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tspr-outside-'));
  outsideFile = path.join(outsideDir, 'secret.txt');
  fs.writeFileSync(outsideFile, 'secret data');

  const port = await getPort();
  handle = await startDashboard({
    port,
    open: false,
    dbPath,
    extraAllowedPaths: [allowedDir],
  });
  baseUrl = handle.url;
});

afterAll(async () => {
  await handle.close();
  try { fs.rmSync(allowedDir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(outsideDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/file — allowlist security', () => {
  it('returns 400 when path param is missing', async () => {
    const res = await get(`${baseUrl}/api/file`);
    expect(res.status).toBe(400);
  });

  it('returns 403 for path outside allowlist', async () => {
    const res = await get(`${baseUrl}/api/file?path=${encodeURIComponent(outsideFile)}`);
    expect(res.status).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/outside allowed/i);
  });

  it('returns 200 with file content for path inside extraAllowedPaths', async () => {
    const res = await get(`${baseUrl}/api/file?path=${encodeURIComponent(allowedFile)}`);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.content).toBe('hello from allowed file');
    expect(body.path).toBe(allowedFile);
    expect(typeof body.lines).toBe('number');
  });

  it('returns 404 for nonexistent file inside allowlist', async () => {
    const nonexistent = path.join(allowedDir, 'does-not-exist.txt');
    const res = await get(`${baseUrl}/api/file?path=${encodeURIComponent(nonexistent)}`);
    expect(res.status).toBe(404);
  });

  it('returns 403 for path traversal attempt (../..)', async () => {
    // Try to escape allowed dir using ../
    const traversal = path.join(allowedDir, '..', '..', 'etc', 'passwd');
    const res = await get(`${baseUrl}/api/file?path=${encodeURIComponent(traversal)}`);
    expect(res.status).toBe(403);
  });

  it('returns 403 for absolute path outside any known root', async () => {
    const systemFile = path.join(os.tmpdir(), 'some-random-' + Date.now() + '.txt');
    // Note: tmpdir itself is not in our allowlist (only allowedDir)
    const res = await get(`${baseUrl}/api/file?path=${encodeURIComponent(systemFile)}`);
    // Should be 403 (outside allowlist) or 404 (not found but allowed is fine too)
    // Key requirement: must not be 200 if path is outside allowlist
    if (res.status === 200) {
      // This would mean the file accidentally exists in an allowed path — fail the test
      expect(res.status).not.toBe(200);
    }
    // Either 403 or 404 is acceptable; must not be 200 for outside paths
    expect([403, 404]).toContain(res.status);
  });
});

// ─── Tests for isPathAllowed / buildAllowlist ─────────────────────────────────

describe('isPathAllowed (unit)', () => {
  it('is importable from server', async () => {
    const mod = await import('../../src/dashboard/server.js');
    expect(typeof mod.isPathAllowed).toBe('function');
    expect(typeof mod.buildAllowlist).toBe('function');
  });

  it('allows paths inside allowed root', async () => {
    const { isPathAllowed, buildAllowlist } = await import('../../src/dashboard/server.js');
    const allowlist = buildAllowlist(['/projects/myapp'], []);
    expect(isPathAllowed('/projects/myapp/src/app.ts', allowlist)).toBe(true);
  });

  it('rejects paths outside allowed root', async () => {
    const { isPathAllowed, buildAllowlist } = await import('../../src/dashboard/server.js');
    const allowlist = buildAllowlist(['/projects/myapp'], []);
    expect(isPathAllowed('/projects/otherapp/secret.ts', allowlist)).toBe(false);
  });

  it('allows paths in ~/.tspr by default', async () => {
    const { isPathAllowed, buildAllowlist } = await import('../../src/dashboard/server.js');
    const allowlist = buildAllowlist([], []);
    const tspr = path.join(os.homedir(), '.tspr', 'runs', 'abc123', 'test_results.json');
    expect(isPathAllowed(tspr, allowlist)).toBe(true);
  });

  it('rejects path traversal that escapes allowed root', async () => {
    const { isPathAllowed, buildAllowlist } = await import('../../src/dashboard/server.js');
    const allowlist = buildAllowlist(['/projects/myapp'], []);
    // path.normalize would resolve ../.. — should end up outside
    expect(isPathAllowed('/projects/otherapp/../secret.txt', allowlist)).toBe(false);
  });
});
