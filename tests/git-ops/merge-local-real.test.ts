/**
 * tests/git-ops/merge-local-real.test.ts
 *
 * Tests for mergeLocal — dirty-tree detection, conflict detection, and
 * clean fast-forward merge (no-ff).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mergeLocal, GitOpsError } from '../../src/git-ops/index.js';

const execFileAsync = promisify(execFile);

async function makeTmpGitRepo(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tspr-merge-test-'));
  await execFileAsync('git', ['init'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 'test@tspr.test'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'tspr-test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'app.ts'), 'export const version = 1;\n');
  await execFileAsync('git', ['add', '.'], { cwd: dir });
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: dir });
  return dir;
}

function cleanup(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

describe('mergeLocal: dry-run', () => {
  it('returns merged:false without touching repo', async () => {
    const dir = await makeTmpGitRepo();
    try {
      const result = await mergeLocal({ projectPath: dir, branch: 'tspr/fix-test', opts: { dryRun: true } });
      expect(result.merged).toBe(false);
    } finally {
      cleanup(dir);
    }
  });
});

describe('mergeLocal: dirty working tree', () => {
  it('throws DIRTY_WORKING_TREE when there are uncommitted changes', async () => {
    const dir = await makeTmpGitRepo();
    try {
      // Create a fix branch
      await execFileAsync('git', ['checkout', '-b', 'tspr/fix-dirty'], { cwd: dir });
      fs.appendFileSync(path.join(dir, 'app.ts'), '// fix\n');
      await execFileAsync('git', ['add', '.'], { cwd: dir });
      await execFileAsync('git', ['commit', '-m', 'fix'], { cwd: dir });
      await execFileAsync('git', ['checkout', 'master'], { cwd: dir }).catch(() =>
        execFileAsync('git', ['checkout', 'main'], { cwd: dir }),
      );

      // Dirty the working tree
      fs.appendFileSync(path.join(dir, 'app.ts'), '// uncommitted change\n');

      await expect(
        mergeLocal({ projectPath: dir, branch: 'tspr/fix-dirty' }),
      ).rejects.toMatchObject({ code: 'DIRTY_WORKING_TREE' });
    } finally {
      cleanup(dir);
    }
  });
});

describe('mergeLocal: clean merge', () => {
  it('merges fix branch into main with --no-ff', async () => {
    const dir = await makeTmpGitRepo();
    try {
      // Create a fix branch
      await execFileAsync('git', ['checkout', '-b', 'tspr/fix-clean'], { cwd: dir });
      fs.appendFileSync(path.join(dir, 'app.ts'), '// auto-fix\n');
      await execFileAsync('git', ['add', '.'], { cwd: dir });
      await execFileAsync('git', ['commit', '-m', 'fix'], { cwd: dir });

      // Switch back to default branch (main or master)
      let baseBranch = 'main';
      try {
        await execFileAsync('git', ['checkout', 'main'], { cwd: dir });
      } catch {
        baseBranch = 'master';
        await execFileAsync('git', ['checkout', 'master'], { cwd: dir });
      }

      const result = await mergeLocal({ projectPath: dir, branch: 'tspr/fix-clean', base: baseBranch });

      expect(result.merged).toBe(true);
      expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
      expect(fs.readFileSync(path.join(dir, 'app.ts'), 'utf-8')).toContain('auto-fix');

      // Verify --no-ff created a merge commit (2 parents)
      const { stdout } = await execFileAsync('git', ['log', '--oneline', '--all'], { cwd: dir });
      // There should be a merge commit visible
      expect(stdout.trim().split('\n').length).toBeGreaterThanOrEqual(2);
    } finally {
      cleanup(dir);
    }
  });
});

describe('mergeLocal: conflict detection', () => {
  it('throws MERGE_CONFLICT and does not leave repo in conflict state', async () => {
    const dir = await makeTmpGitRepo();
    try {
      // On fix branch: modify app.ts
      await execFileAsync('git', ['checkout', '-b', 'tspr/fix-conflict'], { cwd: dir });
      fs.writeFileSync(path.join(dir, 'app.ts'), 'export const version = 99; // conflict fix\n');
      await execFileAsync('git', ['add', '.'], { cwd: dir });
      await execFileAsync('git', ['commit', '-m', 'conflict fix'], { cwd: dir });

      // Back on main: also modify same line
      let baseBranch = 'main';
      try {
        await execFileAsync('git', ['checkout', 'main'], { cwd: dir });
      } catch {
        baseBranch = 'master';
        await execFileAsync('git', ['checkout', 'master'], { cwd: dir });
      }
      fs.writeFileSync(path.join(dir, 'app.ts'), 'export const version = 100; // main change\n');
      await execFileAsync('git', ['add', '.'], { cwd: dir });
      await execFileAsync('git', ['commit', '-m', 'main change'], { cwd: dir });

      await expect(
        mergeLocal({ projectPath: dir, branch: 'tspr/fix-conflict', base: baseBranch }),
      ).rejects.toMatchObject({ code: 'MERGE_CONFLICT' });

      // Repo should NOT be in merge conflict state (abort was called)
      const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: dir });
      expect(stdout).not.toContain('UU');
    } finally {
      cleanup(dir);
    }
  });
});
