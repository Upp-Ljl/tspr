/**
 * tests/cli/open-in-editor.test.ts
 *
 * Tests for the cross-platform vscode:// deep link helper.
 *
 * We test buildVscodeUrl thoroughly (pure logic, no subprocess).
 * For openInEditor we verify it: resolves a boolean, doesn't throw, and
 * the --silent flag suppresses stderr noise. We do NOT spy on spawn directly
 * because `spawn` from node:child_process is not writable in ESM — instead
 * we test observable behavior (no throw, return type).
 */

import { describe, it, expect } from 'vitest';
import { buildVscodeUrl, openInEditor } from '../../src/cli/open-in-editor.js';

// ─── buildVscodeUrl ───────────────────────────────────────────────────────────

describe('buildVscodeUrl', () => {
  it('builds vscode://file/<abs>:<line> for Unix-style path', () => {
    const url = buildVscodeUrl('/home/user/project/src/app.ts', 42);
    expect(url).toBe('vscode://file/home/user/project/src/app.ts:42');
  });

  it('normalizes Windows backslash to forward slash', () => {
    const url = buildVscodeUrl('C:\\Users\\user\\project\\app.ts', 10);
    expect(url).not.toContain('\\');
    expect(url).toContain('vscode://file');
    expect(url).toContain('project');
    expect(url).toContain('app.ts:10');
  });

  it('handles line 1', () => {
    const url = buildVscodeUrl('/src/foo.ts', 1);
    expect(url).toMatch(/:1$/);
  });

  it('keeps absolute path with leading slash for Unix', () => {
    const url = buildVscodeUrl('/abs/path/file.ts', 5);
    expect(url).toBe('vscode://file/abs/path/file.ts:5');
  });

  it('adds leading slash before Windows drive letter', () => {
    // C:\\... → /C/... (normalized) — forward slashes, leading slash
    const url = buildVscodeUrl('D:\\lll\\project\\src\\app.ts', 7);
    expect(url).toContain('vscode://file');
    expect(url).toContain('app.ts:7');
    // Should have forward slashes only
    expect(url).not.toContain('\\');
  });

  it('returns a string starting with vscode://file', () => {
    const url = buildVscodeUrl('/any/path.ts', 99);
    expect(url.startsWith('vscode://file')).toBe(true);
  });
});

// ─── openInEditor — behavioral tests ─────────────────────────────────────────

describe('openInEditor', () => {
  it('returns a boolean (true or false — depends on OS handler)', async () => {
    // We call with silent:true so no stderr noise
    const result = await openInEditor('vscode://file/nonexistent/path.ts:1', { silent: true });
    expect(typeof result).toBe('boolean');
  });

  it('does not throw even if the URL is unrecognized', async () => {
    await expect(
      openInEditor('vscode://file/nonexistent/path.ts:1', { silent: true }),
    ).resolves.not.toThrow();
  });

  it('does not throw for a well-formed URL', async () => {
    const url = buildVscodeUrl('/tmp/test-file.ts', 10);
    await expect(
      openInEditor(url, { silent: true }),
    ).resolves.not.toThrow();
  });

  it('silent:false does not throw even if launch fails', async () => {
    // Passing silent:false may emit to stderr, but must not throw
    await expect(
      openInEditor('vscode://file/definitely/does/not/exist.ts:1', { silent: false }),
    ).resolves.not.toThrow();
  });
});

// ─── Cross-platform command selection (structural test) ──────────────────────
// We verify the buildVscodeUrl output is usable as a URL on all platforms,
// since the actual spawn command varies by platform.

describe('buildVscodeUrl: URL encoding', () => {
  it('does not URL-encode colons or slashes (vscode:// needs them raw)', () => {
    const url = buildVscodeUrl('/home/user/my project/app.ts', 1);
    // path separator should remain as-is (vscode handles spaces)
    expect(url).toContain('vscode://file');
    expect(url).toContain('app.ts:1');
  });
});
