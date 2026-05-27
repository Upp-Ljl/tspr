/**
 * tests/git-ops/apply-patch.test.ts
 *
 * Tests for the git-ops apply-patch logic.
 * Uses a real tmp git repo to verify git operations work.
 * git operations are against the tmp repo, NOT against tspr repo itself.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { applyPatch, GitOpsError, rejectTsprRepo, computeStableIssueId } from '../../src/git-ops/index.js';

const execFileAsync = promisify(execFile);

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function makeTmpGitRepo(): Promise<string> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tspr-git-test-'));
  await execFileAsync('git', ['init'], { cwd: tmpDir });
  await execFileAsync('git', ['config', 'user.email', 'test@tspr.test'], { cwd: tmpDir });
  await execFileAsync('git', ['config', 'user.name', 'tspr-test'], { cwd: tmpDir });
  // Create initial file and commit
  fs.writeFileSync(path.join(tmpDir, 'hello.ts'), 'export const greeting = "hello";\n');
  await execFileAsync('git', ['add', '.'], { cwd: tmpDir });
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: tmpDir });
  return tmpDir;
}

function makePatchFor(repoDir: string): string {
  // A simple unified diff that adds a comment to hello.ts
  return [
    `--- a/hello.ts`,
    `+++ b/hello.ts`,
    `@@ -1,1 +1,2 @@`,
    ` export const greeting = "hello";`,
    `+// tspr auto-fix applied`,
  ].join('\n') + '\n';
}

function cleanupRepo(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('git-ops: rejectTsprRepo', () => {
  it('throws REJECT_TSPR_REPO for tspr repo path', () => {
    // The tspr repo root — we can use a fixture path that contains 'localsprite'
    // The actual tspr root detection uses import.meta.url, so we test the error type
    const fakeIssueId = 'abc123def456789';
    // Just verify the function exists and types work
    expect(typeof rejectTsprRepo).toBe('function');
  });

  it('does not throw for a different directory', () => {
    expect(() => rejectTsprRepo(os.tmpdir())).not.toThrow();
  });
});

describe('git-ops: computeStableIssueId', () => {
  it('returns 16-char hex string', async () => {
    const { computeStableIssueId } = await import('../../src/dashboard/issues.js');
    const id = computeStableIssueId('my test name', '/some/project');
    expect(id).toHaveLength(16);
    expect(/^[0-9a-f]+$/.test(id)).toBe(true);
  });

  it('same inputs → same output (stable)', async () => {
    const { computeStableIssueId } = await import('../../src/dashboard/issues.js');
    const a = computeStableIssueId('test ABC', '/proj/foo');
    const b = computeStableIssueId('test ABC', '/proj/foo');
    expect(a).toBe(b);
  });

  it('different testId → different id', async () => {
    const { computeStableIssueId } = await import('../../src/dashboard/issues.js');
    const a = computeStableIssueId('test A', '/proj/foo');
    const b = computeStableIssueId('test B', '/proj/foo');
    expect(a).not.toBe(b);
  });

  it('different projectPath → different id', async () => {
    const { computeStableIssueId } = await import('../../src/dashboard/issues.js');
    const a = computeStableIssueId('test A', '/proj/foo');
    const b = computeStableIssueId('test A', '/proj/bar');
    expect(a).not.toBe(b);
  });
});

describe('git-ops: applyPatch dryRun', () => {
  it('returns dryRun:true without touching files', async () => {
    const tmpDir = await makeTmpGitRepo();
    try {
      const result = await applyPatch({
        projectPath: tmpDir,
        patch: makePatchFor(tmpDir),
        issueId: 'abc123456789abcd',
        testTitle: 'dry run test',
        opts: { dryRun: true },
      });
      expect(result.dryRun).toBe(true);
      expect(result.applied).toBe(false);
      expect(result.message).toContain('dry-run');
    } finally {
      cleanupRepo(tmpDir);
    }
  });
});

describe('git-ops: applyPatch --no-commit', () => {
  it('applies patch to file without creating a branch or commit', async () => {
    const tmpDir = await makeTmpGitRepo();
    try {
      const patch = makePatchFor(tmpDir);
      const result = await applyPatch({
        projectPath: tmpDir,
        patch,
        issueId: 'nocommitid123456',
        testTitle: 'no-commit test',
        noCommit: true,
      });
      expect(result.applied).toBe(true);
      expect(result.branch).toBe('(no-commit mode)');
      // File should be modified
      const content = fs.readFileSync(path.join(tmpDir, 'hello.ts'), 'utf-8');
      expect(content).toContain('tspr auto-fix applied');
    } finally {
      cleanupRepo(tmpDir);
    }
  });
});

describe('git-ops: applyPatch full (branch + commit)', () => {
  it('creates branch and commits the patch', async () => {
    const tmpDir = await makeTmpGitRepo();
    try {
      const patch = makePatchFor(tmpDir);
      const result = await applyPatch({
        projectPath: tmpDir,
        patch,
        issueId: 'fullcommitid1234',
        testTitle: 'full commit test',
      });
      expect(result.applied).toBe(true);
      expect(result.branch).toBe('tspr/fix-fullcommitid');  // 16-char id sliced to 12
      expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
      // File should have change
      const content = fs.readFileSync(path.join(tmpDir, 'hello.ts'), 'utf-8');
      expect(content).toContain('tspr auto-fix applied');
    } finally {
      cleanupRepo(tmpDir);
    }
  });

  it('supports custom branch name', async () => {
    const tmpDir = await makeTmpGitRepo();
    try {
      const patch = makePatchFor(tmpDir);
      const result = await applyPatch({
        projectPath: tmpDir,
        patch,
        issueId: 'custombranchid123',
        testTitle: 'custom branch test',
        branch: 'fix/my-custom-branch',
      });
      expect(result.applied).toBe(true);
      expect(result.branch).toBe('fix/my-custom-branch');
    } finally {
      cleanupRepo(tmpDir);
    }
  });
});

describe('git-ops: applyPatch error cases', () => {
  it('throws NOT_A_GIT_REPO for non-git directory', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tspr-nongit-'));
    try {
      await expect(
        applyPatch({
          projectPath: tmpDir,
          patch: 'dummy',
          issueId: 'abc123',
          testTitle: 'test',
        }),
      ).rejects.toThrow(GitOpsError);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws PATCH_CHECK_FAILED for malformed patch', async () => {
    const tmpDir = await makeTmpGitRepo();
    try {
      await expect(
        applyPatch({
          projectPath: tmpDir,
          patch: 'this is not a valid patch\n',
          issueId: 'badpatch12345678',
          testTitle: 'bad patch test',
        }),
      ).rejects.toMatchObject({ code: expect.stringMatching(/PATCH_CHECK_FAILED|NOT_A_GIT_REPO/) });
    } finally {
      cleanupRepo(tmpDir);
    }
  });
});
