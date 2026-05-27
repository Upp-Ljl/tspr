/**
 * tests/dashboard/server-actions.test.ts
 *
 * Tests for the new POST routes in the dashboard server:
 *   POST /api/apply-fix
 *   POST /api/push-pr
 *   POST /api/merge-local
 *
 * Git operations are mocked via tmp git repos.
 * These tests verify the HTTP layer (validation, 400/403/404/422 responses)
 * and integration with git-ops for the happy path.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import getPort from 'get-port';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startDashboard } from '../../src/dashboard/server.js';
import { computeStableIssueId } from '../../src/dashboard/issues.js';

const execFileAsync = promisify(execFile);

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function httpPost(
  url: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const opts = new URL(url);
    const req = http.request({
      hostname: opts.hostname,
      port: parseInt(opts.port, 10),
      path: opts.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c: Buffer) => { data += c.toString(); });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) as Record<string, unknown> });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: { raw: data } });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    req.write(bodyStr);
    req.end();
  });
}

async function httpGet(url: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (c: Buffer) => { data += c.toString(); });
      res.on('end', () => {
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode ?? 0, body: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
  });
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

let tmpDbPath: string;
let tmpDbDir: string;
let projectDir: string;
let patchStr: string;
let issueId: string;

function createTestDb(allowedProjectPath: string): string {
  tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tspr-sa-test-'));
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
  ).run('tspr_generate_code_and_execute', 'abc', now, now, 'partial', 3000, allowedProjectPath);

  db.close();
  return tmpDbPath;
}

async function makeTmpGitRepo(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tspr-git-sa-'));
  await execFileAsync('git', ['init'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 'test@tspr.test'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'tspr-test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'hello.ts'), 'export const x = 1;\n');
  await execFileAsync('git', ['add', '.'], { cwd: dir });
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: dir });
  return dir;
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('dashboard POST routes', () => {
  let handle: { url: string; close: () => Promise<void> };
  let baseUrl: string;

  beforeAll(async () => {
    // Create a real tmp git repo to use as project
    projectDir = await makeTmpGitRepo();

    // Generate the patch and issue id
    patchStr = [
      '--- a/hello.ts',
      '+++ b/hello.ts',
      '@@ -1,1 +1,2 @@',
      ' export const x = 1;',
      '+// auto-fixed by tspr',
    ].join('\n') + '\n';

    issueId = computeStableIssueId('my-test GET /api/foo returns 200', projectDir);

    // Write test_results.json to project's .tspr dir
    const tsprDir = path.join(projectDir, '.tspr');
    fs.mkdirSync(tsprDir, { recursive: true });
    const testResults = {
      status: 'partial',
      totalTests: 2,
      passed: 1,
      failed: 1,
      failures: [
        {
          testId: 'my-test GET /api/foo returns 200',
          issueId,
          title: 'GET /api/foo returns 200',
          stack: 'AssertionError: expected 404 to equal 200',
          suggestedPatch: patchStr,
          suggestedFixRegion: { file: 'hello.ts', lineStart: 1, lineEnd: 1, why: 'test' },
        },
      ],
    };
    fs.writeFileSync(path.join(tsprDir, 'test_results.json'), JSON.stringify(testResults));

    // Create db + server
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

  // ── POST /api/apply-fix ────────────────────────────────────────────────────

  describe('POST /api/apply-fix', () => {
    it('400 when missing required fields', async () => {
      const r = await httpPost(`${baseUrl}/api/apply-fix`, {});
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/required/i);
    });

    it('403 when projectPath is not in allowlist', async () => {
      const r = await httpPost(`${baseUrl}/api/apply-fix`, {
        issueId: 'abc',
        projectPath: '/tmp/not-allowed-path-xyz',
      });
      expect(r.status).toBe(403);
      expect(r.body.error).toMatch(/outside allowed/i);
    });

    it('404 when issue not found', async () => {
      const r = await httpPost(`${baseUrl}/api/apply-fix`, {
        issueId: 'nonexistentid1234',
        projectPath: projectDir,
      });
      expect(r.status).toBe(404);
    });

    it('200 dry-run: returns applied:false, dryRun:true', async () => {
      const r = await httpPost(`${baseUrl}/api/apply-fix`, {
        issueId,
        projectPath: projectDir,
        dryRun: true,
      });
      expect(r.status).toBe(200);
      expect(r.body.dryRun).toBe(true);
    });

    it('200 no-commit: applies patch, returns applied:true', async () => {
      // Re-create git repo state for clean test
      // Reset hello.ts back to original (patch may already be applied)
      try {
        await execFileAsync('git', ['checkout', 'HEAD', '--', 'hello.ts'], { cwd: projectDir });
      } catch { /* ignore if already on clean state */ }

      const r = await httpPost(`${baseUrl}/api/apply-fix`, {
        issueId,
        projectPath: projectDir,
        commit: false,
      });
      expect(r.status).toBe(200);
      expect(r.body.applied).toBe(true);
      // File should be modified
      const content = fs.readFileSync(path.join(projectDir, 'hello.ts'), 'utf-8');
      expect(content).toContain('auto-fixed by tspr');
    });
  });

  // ── POST /api/push-pr ──────────────────────────────────────────────────────

  describe('POST /api/push-pr', () => {
    it('400 when missing required fields', async () => {
      const r = await httpPost(`${baseUrl}/api/push-pr`, {});
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/required/i);
    });

    it('403 when projectPath not in allowlist', async () => {
      const r = await httpPost(`${baseUrl}/api/push-pr`, {
        branch: 'fix/test',
        projectPath: '/tmp/not-allowed-push-xyz',
      });
      expect(r.status).toBe(403);
    });

    it('dry-run: returns branch, no actual push', async () => {
      const r = await httpPost(`${baseUrl}/api/push-pr`, {
        branch: 'tspr/fix-dryrun',
        projectPath: projectDir,
        dryRun: true,
      });
      expect(r.status).toBe(200);
      expect(r.body.branch).toBe('tspr/fix-dryrun');
    });

    it('404 for unknown POST routes', async () => {
      const r = await httpPost(`${baseUrl}/api/unknown-route`, {});
      expect(r.status).toBe(404);
    });
  });

  // ── POST /api/merge-local ──────────────────────────────────────────────────

  describe('POST /api/merge-local', () => {
    it('400 when missing required fields', async () => {
      const r = await httpPost(`${baseUrl}/api/merge-local`, {});
      expect(r.status).toBe(400);
    });

    it('403 when projectPath not in allowlist', async () => {
      const r = await httpPost(`${baseUrl}/api/merge-local`, {
        branch: 'fix/test',
        projectPath: '/tmp/not-allowed-merge-xyz',
      });
      expect(r.status).toBe(403);
    });

    it('dry-run: returns merged:false', async () => {
      const r = await httpPost(`${baseUrl}/api/merge-local`, {
        branch: 'tspr/fix-dryrun',
        projectPath: projectDir,
        dryRun: true,
      });
      expect(r.status).toBe(200);
      expect(r.body.merged).toBe(false);
    });
  });

  // ── GET still works (regression) ──────────────────────────────────────────

  describe('existing GET routes still work', () => {
    it('GET /api/runs returns array', async () => {
      const r = await httpGet(`${baseUrl}/api/runs`);
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body)).toBe(true);
    });

    it('GET /api/issues returns array', async () => {
      const r = await httpGet(`${baseUrl}/api/issues`);
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body)).toBe(true);
    });
  });
});
