/**
 * tests/git-ops/push-pr-real.test.ts
 *
 * Tests for pushPr — real GH CLI invocation or clear error when gh missing.
 *
 * NOTE: These tests do NOT actually push to GitHub.
 * - When `gh` is installed: push fails (no remote) → PR_CREATE_FAILED
 * - When `gh` is not installed: throws GH_NOT_FOUND with install URL
 *
 * Both confirm the real codepath (not dry-run) was reached.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pushPr, rejectTsprRepo, GitOpsError } from '../../src/git-ops/index.js';

const execFileAsync = promisify(execFile);

async function makeTmpGitRepo(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tspr-pushpr-test-'));
  await execFileAsync('git', ['init'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 'test@tspr.test'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'tspr-test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'app.ts'), 'export const x = 1;\n');
  await execFileAsync('git', ['add', '.'], { cwd: dir });
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: dir });
  return dir;
}

function cleanup(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

async function isGhAvailable(): Promise<boolean> {
  try {
    await execFileAsync('gh', ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

describe('pushPr: dry-run', () => {
  it('returns branch without pushing when dryRun:true', async () => {
    const dir = await makeTmpGitRepo();
    try {
      const result = await pushPr({
        projectPath: dir,
        branch: 'tspr/fix-dryrun-test',
        opts: { dryRun: true },
      });
      expect(result.branch).toBe('tspr/fix-dryrun-test');
      expect(result.prUrl).toBeUndefined();
    } finally {
      cleanup(dir);
    }
  });
});

describe('pushPr: real — no remote configured', () => {
  it('throws GH_NOT_FOUND when gh is not installed', async () => {
    if (await isGhAvailable()) {
      // gh is installed; this test is for the missing-gh case
      return;
    }
    const dir = await makeTmpGitRepo();
    try {
      let caught: GitOpsError | null = null;
      try {
        await pushPr({ projectPath: dir, branch: 'tspr/fix-test' });
      } catch (err) {
        if (err instanceof GitOpsError) caught = err;
      }
      expect(caught).not.toBeNull();
      expect(caught?.code).toBe('GH_NOT_FOUND');
      expect(caught?.detail).toContain('cli.github.com');
    } finally {
      cleanup(dir);
    }
  });

  it('throws PR_CREATE_FAILED when gh exists but no remote (push fails)', async () => {
    if (!await isGhAvailable()) {
      // gh not installed; skip
      return;
    }
    const dir = await makeTmpGitRepo();
    try {
      // Create the branch first so it exists
      await execFileAsync('git', ['checkout', '-b', 'tspr/fix-no-remote'], { cwd: dir });
      let caught: GitOpsError | null = null;
      try {
        await pushPr({ projectPath: dir, branch: 'tspr/fix-no-remote' });
      } catch (err) {
        if (err instanceof GitOpsError) caught = err;
      }
      expect(caught).not.toBeNull();
      expect(caught?.code).toBe('PR_CREATE_FAILED');
    } finally {
      cleanup(dir);
    }
  });
});

describe('rejectTsprRepo: unit tests', () => {
  it('does not throw for a tmp directory', () => {
    expect(() => rejectTsprRepo(os.tmpdir())).not.toThrow();
  });

  it('does not throw for a random non-tspr path', () => {
    expect(() => rejectTsprRepo('/some/random/path')).not.toThrow();
  });

  it('throws GitOpsError(REJECT_TSPR_REPO) for the exact tspr root', () => {
    // The tspr root is determined by import.meta.url in the compiled module.
    // We test by constructing the path based on where the source file lives.
    // In the worktree, __dirname equivalent is in .worktrees/r16-pwr/src/git-ops/
    // Three levels up is .worktrees/r16-pwr
    const worktreeRoot = path.resolve(
      path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
      '..', '..', '..',
    );
    // This is our worktree root — it should be the tspr repo root detected
    expect(() => rejectTsprRepo(worktreeRoot)).toThrow(GitOpsError);
    try {
      rejectTsprRepo(worktreeRoot);
    } catch (err) {
      expect((err as GitOpsError).code).toBe('REJECT_TSPR_REPO');
    }
  });
});
