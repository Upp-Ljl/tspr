/**
 * tests/dashboard/post-actions-real.test.ts
 *
 * Tests for the real (non-stub) POST routes added in Phase 2:
 *   POST /api/push-pr  — gated by ?confirm=true
 *   POST /api/merge-local — gated by ?confirm=true
 *   POST /api/open-in-editor — always executes (no gate)
 */

import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import getPort from 'get-port';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startDashboard } from '../../src/dashboard/server.js';

const execFileAsync = promisify(execFile);

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function httpPost(
  url: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const opts = new URL(url);
    const req = http.request(
      {
        hostname: opts.hostname,
        port: parseInt(opts.port, 10),
        path: opts.pathname + (opts.search ?? ''),
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c: Buffer) => { data += c.toString(); });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) as Record<string, unknown> });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: { raw: data } });
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error('timeout')));
    req.write(bodyStr);
    req.end();
  });
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

let tmpDbDir: string;
let tmpDbPath: string;
let projectDir: string;

function createTestDb(allowedProjectPath: string): string {
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tspr-post-real-'));
  tmpDbPath = path.join(tmpDbDir, 'db.sqlite');
  const db = new Database(tmpDbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool TEXT NOT NULL,
      params_hash TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL,
      ended_at TEXT,
      outcome TEXT,
      error_code TEXT,
      duration_ms INTEGER,
      project_path TEXT
    );
    CREATE TABLE IF NOT EXISTS test_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER,
      test_id TEXT NOT NULL,
      title TEXT,
      outcome TEXT,
      stack TEXT
    );
  `);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO runs (tool, params_hash, started_at, ended_at, outcome, duration_ms, project_path)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('tspr_generate_code_and_execute', 'abc', now, now, 'partial', 1000, allowedProjectPath);
  db.close();
  return tmpDbPath;
}

async function makeTmpGitRepo(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tspr-git-post-real-'));
  await execFileAsync('git', ['init'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 'test@tspr.test'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'tspr-test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'app.ts'), 'export const x = 1;\n');
  await execFileAsync('git', ['add', '.'], { cwd: dir });
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: dir });
  return dir;
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('POST routes: real gate + open-in-editor', () => {
  let handle: { url: string; close: () => Promise<void> };
  let baseUrl: string;

  beforeAll(async () => {
    projectDir = await makeTmpGitRepo();
    const dbPath = createTestDb(projectDir);
    const port = await getPort();
    handle = await startDashboard({ port, open: false, dbPath, extraAllowedPaths: [projectDir] });
    baseUrl = handle.url;
  });

  afterAll(async () => {
    await handle.close();
    try { fs.rmSync(tmpDbDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── POST /api/push-pr ──────────────────────────────────────────────────────

  describe('POST /api/push-pr: confirm gate', () => {
    it('returns requiresConfirm:true when ?confirm=true is missing (not dry-run)', async () => {
      const r = await httpPost(`${baseUrl}/api/push-pr`, {
        branch: 'tspr/fix-gate-test',
        projectPath: projectDir,
      });
      expect(r.status).toBe(200);
      expect(r.body.requiresConfirm).toBe(true);
      expect(typeof r.body.message).toBe('string');
    });

    it('proceeds past gate when ?confirm=true is present (may throw GH_NOT_FOUND or PR_CREATE_FAILED)', async () => {
      const r = await httpPost(`${baseUrl}/api/push-pr?confirm=true`, {
        branch: 'tspr/fix-gate-confirmed',
        projectPath: projectDir,
      });
      // Either succeeds (unlikely without remote) or returns 422 with a git-ops error code
      expect([200, 422]).toContain(r.status);
      if (r.status === 422) {
        expect(['GH_NOT_FOUND', 'PR_CREATE_FAILED']).toContain(r.body.code);
      }
    });

    it('dry-run bypasses gate even without ?confirm=true', async () => {
      const r = await httpPost(`${baseUrl}/api/push-pr`, {
        branch: 'tspr/fix-dryrun-gate',
        projectPath: projectDir,
        dryRun: true,
      });
      expect(r.status).toBe(200);
      expect(r.body.requiresConfirm).toBeUndefined();
    });
  });

  // ── POST /api/merge-local ──────────────────────────────────────────────────

  describe('POST /api/merge-local: confirm gate', () => {
    it('returns requiresConfirm:true when ?confirm=true is missing', async () => {
      const r = await httpPost(`${baseUrl}/api/merge-local`, {
        branch: 'tspr/fix-merge-gate',
        projectPath: projectDir,
      });
      expect(r.status).toBe(200);
      expect(r.body.requiresConfirm).toBe(true);
    });

    it('dry-run bypasses gate', async () => {
      const r = await httpPost(`${baseUrl}/api/merge-local`, {
        branch: 'tspr/fix-dry',
        projectPath: projectDir,
        dryRun: true,
      });
      expect(r.status).toBe(200);
      expect(r.body.merged).toBe(false);
      expect(r.body.requiresConfirm).toBeUndefined();
    });

    it('proceeds with confirm=true (may fail with no branch or dirty tree — not requiresConfirm)', async () => {
      const r = await httpPost(`${baseUrl}/api/merge-local?confirm=true`, {
        branch: 'tspr/nonexistent-branch',
        projectPath: projectDir,
      });
      expect([200, 422]).toContain(r.status);
      if (r.status === 422) {
        // Not a confirm gate error — a real git error
        expect(r.body.requiresConfirm).toBeUndefined();
      }
    });
  });

  // ── POST /api/open-in-editor ───────────────────────────────────────────────

  describe('POST /api/open-in-editor', () => {
    it('returns 400 when file is missing', async () => {
      const r = await httpPost(`${baseUrl}/api/open-in-editor`, {});
      expect(r.status).toBe(400);
      expect(String(r.body.error)).toMatch(/file.*required/i);
    });

    it('returns 200 with url even if handler fails silently', async () => {
      const r = await httpPost(`${baseUrl}/api/open-in-editor`, {
        file: '/some/abs/path/app.ts',
        line: 42,
      });
      expect(r.status).toBe(200);
      expect(typeof r.body.url).toBe('string');
      expect(String(r.body.url)).toContain('vscode://file');
      expect(String(r.body.url)).toContain('app.ts:42');
    });

    it('defaults line to 1 when not provided', async () => {
      const r = await httpPost(`${baseUrl}/api/open-in-editor`, {
        file: '/some/file.ts',
      });
      expect(r.status).toBe(200);
      expect(String(r.body.url)).toMatch(/:1$/);
    });
  });

  // ── Sibling routes not touched ─────────────────────────────────────────────

  describe('Routes intentionally not touched (sibling A)', () => {
    it('POST /api/onboarding-dismiss returns 404 (not added by us)', async () => {
      const r = await httpPost(`${baseUrl}/api/onboarding-dismiss`, {});
      expect(r.status).toBe(404);
    });

    it('POST /api/onboarding-state would return 404 (not a POST route here)', async () => {
      const r = await httpPost(`${baseUrl}/api/onboarding-state`, {});
      expect(r.status).toBe(404);
    });
  });
});
