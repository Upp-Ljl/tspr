/**
 * tests/cli/apply-fix.test.ts
 *
 * Tests for the tspr apply-fix CLI subcommand.
 * Verifies argument parsing, error cases, and integration with git-ops.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runApplyFixCommand } from '../../src/cli/apply-fix-command.js';
import { computeStableIssueId } from '../../src/dashboard/issues.js';

const execFileAsync = promisify(execFile);

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function makeTmpGitRepo(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tspr-cli-test-'));
  await execFileAsync('git', ['init'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 'test@tspr.test'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'tspr-test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'app.ts'), 'export const version = 1;\n');
  await execFileAsync('git', ['add', '.'], { cwd: dir });
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: dir });
  return dir;
}

function cleanupRepo(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function makeTestResults(projectDir: string, patch?: string): Record<string, unknown> {
  const testId = 'GET /api/foo returns 200';
  const id = computeStableIssueId(testId, projectDir);
  return {
    status: 'partial',
    failures: [
      {
        testId,
        issueId: id,
        title: testId,
        stack: 'AssertionError: expected 404 to equal 200',
        suggestedPatch: patch ?? [
          '--- a/app.ts',
          '+++ b/app.ts',
          '@@ -1,1 +1,2 @@',
          ' export const version = 1;',
          '+// fixed',
        ].join('\n') + '\n',
        suggestedFixRegion: { file: 'app.ts', lineStart: 1, lineEnd: 1, why: 'wrong version' },
      },
    ],
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('apply-fix CLI: argument validation', () => {
  it('returns 1 and writes usage when no issue-id given', async () => {
    const origStderr = process.stderr.write.bind(process.stderr);
    let stderrOutput = '';
    process.stderr.write = (s: string) => { stderrOutput += s; return true; };
    const code = await runApplyFixCommand([]);
    process.stderr.write = origStderr;
    expect(code).toBe(1);
    expect(stderrOutput).toContain('Usage');
  });

  it('returns 1 when test_results.json not found', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tspr-nofile-'));
    try {
      const code = await runApplyFixCommand(['someissueid', '--project', tmpDir]);
      expect(code).toBe(1);
    } finally {
      cleanupRepo(tmpDir);
    }
  });
});

describe('apply-fix CLI: issue not found', () => {
  it('returns 1 when issue id not in failures', async () => {
    const repoDir = await makeTmpGitRepo();
    try {
      const tsprDir = path.join(repoDir, '.tspr');
      fs.mkdirSync(tsprDir, { recursive: true });
      fs.writeFileSync(path.join(tsprDir, 'test_results.json'), JSON.stringify(makeTestResults(repoDir)));
      const code = await runApplyFixCommand(['nonexistentid9999', '--project', repoDir]);
      expect(code).toBe(1);
    } finally {
      cleanupRepo(repoDir);
    }
  });
});

describe('apply-fix CLI: no patch available', () => {
  it('returns 0 and prints fix region hint', async () => {
    const repoDir = await makeTmpGitRepo();
    try {
      const testId = 'no patch test';
      const id = computeStableIssueId(testId, repoDir);
      const results = {
        failures: [{
          testId,
          issueId: id,
          title: testId,
          stack: 'Error',
          suggestedFixRegion: { file: 'app.ts', lineStart: 5, lineEnd: 10, why: 'bad logic' },
          // no suggestedPatch
        }],
      };
      const tsprDir = path.join(repoDir, '.tspr');
      fs.mkdirSync(tsprDir, { recursive: true });
      fs.writeFileSync(path.join(tsprDir, 'test_results.json'), JSON.stringify(results));

      let stdoutOutput = '';
      const origWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = (s: string) => { stdoutOutput += s; return true; };
      const code = await runApplyFixCommand([id, '--project', repoDir]);
      process.stdout.write = origWrite;

      expect(code).toBe(0);
      expect(stdoutOutput).toContain('app.ts');
    } finally {
      cleanupRepo(repoDir);
    }
  });
});

describe('apply-fix CLI: dry-run', () => {
  it('returns 0 and does not modify files', async () => {
    const repoDir = await makeTmpGitRepo();
    try {
      const tsprDir = path.join(repoDir, '.tspr');
      fs.mkdirSync(tsprDir, { recursive: true });
      const results = makeTestResults(repoDir);
      const issueId = (results.failures as Array<{ issueId: string }>)[0].issueId;
      fs.writeFileSync(path.join(tsprDir, 'test_results.json'), JSON.stringify(results));

      const originalContent = fs.readFileSync(path.join(repoDir, 'app.ts'), 'utf-8');
      const code = await runApplyFixCommand([issueId, '--dry-run', '--project', repoDir]);
      expect(code).toBe(0);
      // File should NOT be modified
      const afterContent = fs.readFileSync(path.join(repoDir, 'app.ts'), 'utf-8');
      expect(afterContent).toBe(originalContent);
    } finally {
      cleanupRepo(repoDir);
    }
  });
});

describe('apply-fix CLI: --no-commit', () => {
  it('applies patch to file without creating git branch', async () => {
    const repoDir = await makeTmpGitRepo();
    try {
      const tsprDir = path.join(repoDir, '.tspr');
      fs.mkdirSync(tsprDir, { recursive: true });
      const results = makeTestResults(repoDir);
      const issueId = (results.failures as Array<{ issueId: string }>)[0].issueId;
      fs.writeFileSync(path.join(tsprDir, 'test_results.json'), JSON.stringify(results));

      const code = await runApplyFixCommand([issueId, '--no-commit', '--project', repoDir]);
      expect(code).toBe(0);
      // File should be modified
      const content = fs.readFileSync(path.join(repoDir, 'app.ts'), 'utf-8');
      expect(content).toContain('fixed');
    } finally {
      cleanupRepo(repoDir);
    }
  });
});

describe('apply-fix CLI: full apply (branch + commit)', () => {
  it('creates branch and commits when patch is valid', async () => {
    const repoDir = await makeTmpGitRepo();
    try {
      const tsprDir = path.join(repoDir, '.tspr');
      fs.mkdirSync(tsprDir, { recursive: true });
      const results = makeTestResults(repoDir);
      const issueId = (results.failures as Array<{ issueId: string }>)[0].issueId;
      fs.writeFileSync(path.join(tsprDir, 'test_results.json'), JSON.stringify(results));

      let stdoutOutput = '';
      const origWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = (s: string) => { stdoutOutput += s; return true; };
      const code = await runApplyFixCommand([issueId, '--project', repoDir]);
      process.stdout.write = origWrite;

      expect(code).toBe(0);
      expect(stdoutOutput).toContain('Branch:');
      // File should be modified
      const content = fs.readFileSync(path.join(repoDir, 'app.ts'), 'utf-8');
      expect(content).toContain('fixed');
    } finally {
      cleanupRepo(repoDir);
    }
  });
});
