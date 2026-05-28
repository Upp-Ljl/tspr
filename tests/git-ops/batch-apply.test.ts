/**
 * tests/git-ops/batch-apply.test.ts
 *
 * Tests for batchApplyPatches — atomic multi-patch git commit.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { batchApplyPatches, GitOpsError } from '../../src/git-ops/index.js';

const execFileAsync = promisify(execFile);

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function makeTmpGitRepo(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tspr-batch-test-'));
  await execFileAsync('git', ['init'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 'test@tspr.test'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'tspr-test'], { cwd: dir });
  // Two independent files
  fs.writeFileSync(path.join(dir, 'alpha.ts'), 'export const alpha = 1;\n');
  fs.writeFileSync(path.join(dir, 'beta.ts'), 'export const beta = 2;\n');
  await execFileAsync('git', ['add', '.'], { cwd: dir });
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: dir });
  return dir;
}

function cleanup(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function alphaPatch(): string {
  return [
    '--- a/alpha.ts',
    '+++ b/alpha.ts',
    '@@ -1,1 +1,2 @@',
    ' export const alpha = 1;',
    '+// alpha fixed',
  ].join('\n') + '\n';
}

function betaPatch(): string {
  return [
    '--- a/beta.ts',
    '+++ b/beta.ts',
    '@@ -1,1 +1,2 @@',
    ' export const beta = 2;',
    '+// beta fixed',
  ].join('\n') + '\n';
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('batchApplyPatches: empty input', () => {
  it('returns applied:false with message when no patches given', async () => {
    const dir = await makeTmpGitRepo();
    try {
      const result = await batchApplyPatches({
        projectPath: dir,
        patches: [],
      });
      expect(result.applied).toBe(false);
      expect(result.message).toMatch(/no patches/i);
    } finally {
      cleanup(dir);
    }
  });
});

describe('batchApplyPatches: dry-run', () => {
  it('returns dryRun:true and does not touch files', async () => {
    const dir = await makeTmpGitRepo();
    try {
      const result = await batchApplyPatches({
        projectPath: dir,
        patches: [
          { issueId: 'aaa1', patch: alphaPatch(), testTitle: 'alpha test' },
          { issueId: 'bbb2', patch: betaPatch(), testTitle: 'beta test' },
        ],
        opts: { dryRun: true },
      });
      expect(result.dryRun).toBe(true);
      expect(result.applied).toBe(false);
      // Files should be untouched
      expect(fs.readFileSync(path.join(dir, 'alpha.ts'), 'utf-8')).not.toContain('alpha fixed');
    } finally {
      cleanup(dir);
    }
  });
});

describe('batchApplyPatches: single patch (same as applyPatch)', () => {
  it('applies one patch and creates one commit', async () => {
    const dir = await makeTmpGitRepo();
    try {
      const result = await batchApplyPatches({
        projectPath: dir,
        patches: [
          { issueId: 'aaa1bbb2ccc3ddd4', patch: alphaPatch(), testTitle: 'alpha test' },
        ],
      });
      expect(result.applied).toBe(true);
      expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
      expect(fs.readFileSync(path.join(dir, 'alpha.ts'), 'utf-8')).toContain('alpha fixed');
    } finally {
      cleanup(dir);
    }
  });
});

describe('batchApplyPatches: two patches → ONE commit', () => {
  it('applies both patches in a single commit on a single branch', async () => {
    const dir = await makeTmpGitRepo();
    try {
      const result = await batchApplyPatches({
        projectPath: dir,
        patches: [
          { issueId: 'aaa1bbb2ccc3ddd4', patch: alphaPatch(), testTitle: 'alpha test' },
          { issueId: 'eee5fff6ggg7hhh8', patch: betaPatch(), testTitle: 'beta test' },
        ],
        commitMessage: 'fix: tspr batch — 2 issues applied',
      });
      expect(result.applied).toBe(true);
      expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);

      // Both files modified
      expect(fs.readFileSync(path.join(dir, 'alpha.ts'), 'utf-8')).toContain('alpha fixed');
      expect(fs.readFileSync(path.join(dir, 'beta.ts'), 'utf-8')).toContain('beta fixed');

      // Exactly ONE new commit on top of init
      const { stdout } = await execFileAsync('git', ['log', '--oneline'], { cwd: dir });
      const lines = stdout.trim().split('\n').filter(Boolean);
      expect(lines).toHaveLength(2); // init + batch commit

      // Branch was created
      expect(result.branch).toBeTruthy();
    } finally {
      cleanup(dir);
    }
  });

  it('uses custom commit message', async () => {
    const dir = await makeTmpGitRepo();
    try {
      await batchApplyPatches({
        projectPath: dir,
        patches: [
          { issueId: 'aaa1', patch: alphaPatch(), testTitle: 'alpha' },
        ],
        commitMessage: 'chore: custom msg',
      });
      const { stdout } = await execFileAsync('git', ['log', '-1', '--pretty=%s'], { cwd: dir });
      expect(stdout.trim()).toBe('chore: custom msg');
    } finally {
      cleanup(dir);
    }
  });

  it('uses custom branch name', async () => {
    const dir = await makeTmpGitRepo();
    try {
      const result = await batchApplyPatches({
        projectPath: dir,
        patches: [
          { issueId: 'aaa1', patch: alphaPatch(), testTitle: 'alpha' },
        ],
        branch: 'fix/custom-batch-branch',
      });
      expect(result.branch).toBe('fix/custom-batch-branch');
    } finally {
      cleanup(dir);
    }
  });
});

describe('batchApplyPatches: --check before apply (abort on bad patch)', () => {
  it('throws PATCH_CHECK_FAILED if second patch is invalid, without applying first', async () => {
    const dir = await makeTmpGitRepo();
    try {
      await expect(
        batchApplyPatches({
          projectPath: dir,
          patches: [
            { issueId: 'aaa1', patch: alphaPatch(), testTitle: 'alpha' },
            { issueId: 'bad2', patch: 'this is not a valid patch\n', testTitle: 'bad patch' },
          ],
        }),
      ).rejects.toMatchObject({ code: 'PATCH_CHECK_FAILED' });

      // First file should NOT have been modified
      expect(fs.readFileSync(path.join(dir, 'alpha.ts'), 'utf-8')).not.toContain('alpha fixed');
    } finally {
      cleanup(dir);
    }
  });
});

describe('batchApplyPatches: --no-commit', () => {
  it('applies both patches without branching or committing', async () => {
    const dir = await makeTmpGitRepo();
    try {
      const result = await batchApplyPatches({
        projectPath: dir,
        patches: [
          { issueId: 'aaa1', patch: alphaPatch(), testTitle: 'alpha' },
          { issueId: 'bbb2', patch: betaPatch(), testTitle: 'beta' },
        ],
        noCommit: true,
      });
      expect(result.applied).toBe(true);
      expect(result.branch).toBe('(no-commit mode)');
      expect(fs.readFileSync(path.join(dir, 'alpha.ts'), 'utf-8')).toContain('alpha fixed');
      expect(fs.readFileSync(path.join(dir, 'beta.ts'), 'utf-8')).toContain('beta fixed');
    } finally {
      cleanup(dir);
    }
  });
});
