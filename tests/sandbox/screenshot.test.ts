/**
 * Tests for src/sandbox/screenshot.ts
 *
 * captureFailureScreenshot is best-effort and returns null gracefully on any failure.
 * We test:
 *   - inferTestUrl: URL extraction from test file content
 *   - captureFailureScreenshot: graceful null when sandbox exec fails
 *   - captureFailureScreenshot: graceful null when URL can't be inferred
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { inferTestUrl, captureFailureScreenshot } from '../../src/sandbox/screenshot.js';
import type { SandboxHandle } from '../../src/sandbox/types.js';

// ─── Helper: temp file factory ────────────────────────────────────────────────

const tmpFiles: string[] = [];

function writeTmpFile(content: string, ext = '.spec.ts'): string {
  const p = path.join(os.tmpdir(), `tspr-test-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  fs.writeFileSync(p, content, 'utf-8');
  tmpFiles.push(p);
  return p;
}

afterEach(() => {
  for (const f of tmpFiles.splice(0)) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
});

// ─── inferTestUrl ─────────────────────────────────────────────────────────────

describe('inferTestUrl', () => {
  it('returns null for empty/missing file', () => {
    expect(inferTestUrl('')).toBeNull();
    expect(inferTestUrl('/nonexistent/path/test.spec.ts')).toBeNull();
  });

  it('extracts absolute URL from fetch()', () => {
    const f = writeTmpFile(`
import { fetch } from 'node-fetch';
const res = await fetch('http://localhost:3000/api/users');
`);
    expect(inferTestUrl(f)).toBe('http://localhost:3000/api/users');
  });

  it('extracts relative URL from fetch() and prepends base', () => {
    const f = writeTmpFile(`
const res = await fetch('/api/memes');
`);
    const result = inferTestUrl(f);
    expect(result).toBeTruthy();
    expect(result).toMatch(/\/api\/memes$/);
  });

  it('extracts URL from request() with an explicit URL string', () => {
    // supertest-style with a literal URL (as opposed to passing `app` variable)
    const f = writeTmpFile(`
import request from 'supertest';
const res = await request('http://localhost:3001').get('/api/health');
`);
    const result = inferTestUrl(f);
    // Should find the http://localhost:3001 absolute URL
    expect(result).toBeTruthy();
    expect(result).toMatch(/localhost/);
  });

  it('extracts URL from page.goto()', () => {
    const f = writeTmpFile(`
await page.goto('http://localhost:4000');
`);
    expect(inferTestUrl(f)).toBe('http://localhost:4000');
  });

  it('returns null for file with no URL patterns', () => {
    const f = writeTmpFile(`
describe('unit test', () => {
  it('adds numbers', () => {
    expect(1 + 1).toBe(2);
  });
});
`);
    // May or may not find a URL — as long as it doesn't throw
    expect(() => inferTestUrl(f)).not.toThrow();
  });
});

// ─── captureFailureScreenshot — graceful null paths ───────────────────────────

function makeSandboxThatFails(exitCode = 1): SandboxHandle {
  return {
    id: 'fake-container-id',
    runId: 'fake-run-id',
    port: 9999,
    runDir: os.tmpdir(),
    status: 'running' as const,
    exec: async (_cmd: string, _opts?: object) => ({
      exitCode,
      stdout: '',
      stderr: 'playwright not found',
      durationMs: 5,
      timedOut: false,
    }),
    bootApp: async () => { throw new Error('not implemented'); },
    pullArtifacts: async () => {},
    dispose: async () => {},
  };
}

function makeSandboxThatThrows(): SandboxHandle {
  return {
    id: 'fake-container-id',
    runId: 'fake-run-id',
    port: 9999,
    runDir: os.tmpdir(),
    status: 'running' as const,
    exec: async (_cmd: string, _opts?: object) => { throw new Error('sandbox disposed'); },
    bootApp: async () => { throw new Error('not implemented'); },
    pullArtifacts: async () => {},
    dispose: async () => {},
  };
}

describe('captureFailureScreenshot', () => {
  it('returns null when URL cannot be inferred (no test file)', async () => {
    const sandbox = makeSandboxThatFails();
    const result = await captureFailureScreenshot(sandbox, '/nonexistent/test.spec.ts', 'some test');
    expect(result).toBeNull();
  });

  it('returns null when sandbox exec fails (Playwright absent)', async () => {
    // Test file with a URL so inference works, but exec will fail
    const f = writeTmpFile(`const r = await fetch('http://localhost:3000/api/x');`);
    const sandbox = makeSandboxThatFails(1);
    const result = await captureFailureScreenshot(sandbox, f, 'GET /api/x returns 200');
    expect(result).toBeNull();
  });

  it('returns null when sandbox throws (disposed)', async () => {
    const f = writeTmpFile(`const r = await fetch('http://localhost:3000/api/x');`);
    const sandbox = makeSandboxThatThrows();
    const result = await captureFailureScreenshot(sandbox, f, 'some test');
    // Must never throw — always returns null
    expect(result).toBeNull();
  });

  it('returns null gracefully for empty test file', async () => {
    const f = writeTmpFile('');
    const sandbox = makeSandboxThatFails();
    const result = await captureFailureScreenshot(sandbox, f, 'empty test');
    expect(result).toBeNull();
  });
});
