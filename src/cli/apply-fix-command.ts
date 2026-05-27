/**
 * src/cli/apply-fix-command.ts
 *
 * CLI subcommand: tspr apply-fix <issue-id> [options]
 *
 * Looks up the issue by stable ID from the latest run's test_results.json
 * (from the project's .tspr/test_results.json), then applies the suggestedPatch
 * via git apply (or prints fix region if no patch available).
 *
 * Usage:
 *   tspr apply-fix <issue-id>                  — apply patch, create branch, commit
 *   tspr apply-fix <issue-id> --no-commit       — apply patch only, no git
 *   tspr apply-fix <issue-id> --branch my-fix   — use custom branch name
 *   tspr apply-fix <issue-id> --dry-run         — show what would happen
 *   tspr apply-fix <issue-id> --project /path   — explicit project path
 */

import fs from 'node:fs';
import path from 'node:path';
import { applyPatch, GitOpsError } from '../git-ops/index.js';
import type { FixedIssueEntry } from '../dashboard/issues.js';

// ─── Types ─────────────────────────────────────────────────────────────────────

interface ApplyFixOptions {
  noCommit: boolean;
  branch?: string;
  dryRun: boolean;
  projectPath?: string;
}

// Match what test_results.json looks like on disk (ExecuteResult shape)
interface StoredResult {
  failures?: Array<{
    testId: string;
    title?: string;
    stack?: string;
    suggestedFixRegion?: {
      file: string;
      lineStart: number;
      lineEnd: number;
      why: string;
    };
    suggestedPatch?: string;
    /** stable issue id added by us */
    issueId?: string;
  }>;
}

// ─── ID helpers ────────────────────────────────────────────────────────────────

/** Import at runtime to avoid circular dep — same function as in issues.ts */
async function computeIssueId(testId: string, projectPath: string): Promise<string> {
  const { computeStableIssueId } = await import('../dashboard/issues.js');
  return computeStableIssueId(testId, projectPath);
}

// ─── Find issue in test_results ────────────────────────────────────────────────

async function findIssue(
  issueId: string,
  projectPath: string,
): Promise<{ failure: NonNullable<StoredResult['failures']>[0]; projectPath: string } | null> {
  const tsprDir = path.join(projectPath, '.tspr');
  const resultsPath = path.join(tsprDir, 'test_results.json');

  if (!fs.existsSync(resultsPath)) {
    return null;
  }

  let stored: StoredResult;
  try {
    stored = JSON.parse(fs.readFileSync(resultsPath, 'utf-8')) as StoredResult;
  } catch {
    return null;
  }

  if (!stored.failures || stored.failures.length === 0) return null;

  for (const failure of stored.failures) {
    // Check pre-computed issueId first (backward compat if already stored)
    if (failure.issueId && failure.issueId === issueId) {
      return { failure, projectPath };
    }
    // Compute stable id on-the-fly
    const computed = await computeIssueId(failure.testId, projectPath);
    if (computed === issueId || computed.startsWith(issueId) || issueId.startsWith(computed.slice(0, issueId.length))) {
      return { failure, projectPath };
    }
  }
  return null;
}

// ─── Command entry ─────────────────────────────────────────────────────────────

export async function runApplyFixCommand(args: string[]): Promise<number> {
  // Parse args
  const positional: string[] = [];
  const opts: ApplyFixOptions = { noCommit: false, dryRun: false };

  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === '--no-commit') {
      opts.noCommit = true;
    } else if (a === '--dry-run') {
      opts.dryRun = true;
    } else if (a === '--branch' && args[i + 1]) {
      opts.branch = args[i + 1];
      i++;
    } else if (a === '--project' && args[i + 1]) {
      opts.projectPath = args[i + 1];
      i++;
    } else if (!a.startsWith('--')) {
      positional.push(a);
    }
    i++;
  }

  const issueId = positional[0];
  if (!issueId) {
    process.stderr.write('[tspr apply-fix] Usage: tspr apply-fix <issue-id> [--no-commit] [--branch <name>] [--dry-run] [--project <path>]\n');
    return 1;
  }

  // Resolve project path
  const projectPath = opts.projectPath ?? process.cwd();
  const resolvedProject = path.resolve(projectPath);

  // Find the failure record
  const found = await findIssue(issueId, resolvedProject);
  if (!found) {
    process.stderr.write(`[tspr apply-fix] Issue "${issueId}" not found in ${resolvedProject}/.tspr/test_results.json\n`);
    process.stderr.write(`  Tip: list issues with: tspr dashboard\n`);
    return 1;
  }

  const { failure } = found;

  // No patch available — print fix region hint
  if (!failure.suggestedPatch) {
    if (failure.suggestedFixRegion) {
      const r = failure.suggestedFixRegion;
      process.stdout.write(
        `[tspr apply-fix] No auto-fix patch available for "${failure.title ?? failure.testId}".\n` +
        `  Where to look: ${r.file}:${r.lineStart}–${r.lineEnd}\n` +
        `  Hint: ${r.why}\n`,
      );
    } else {
      process.stdout.write(`[tspr apply-fix] No auto-fix available for "${failure.title ?? failure.testId}". No patch or fix region present.\n`);
    }
    return 0;
  }

  if (opts.dryRun) {
    process.stdout.write(`[tspr apply-fix] [dry-run] Would apply patch for "${failure.title ?? failure.testId}"\n`);
    process.stdout.write(`  Branch: ${opts.branch ?? `tspr/fix-${issueId.slice(0, 12)}`}\n`);
    process.stdout.write(`  No-commit: ${opts.noCommit}\n`);
    return 0;
  }

  try {
    const result = await applyPatch({
      projectPath: resolvedProject,
      patch: failure.suggestedPatch,
      issueId,
      testTitle: failure.title ?? failure.testId,
      branch: opts.branch,
      noCommit: opts.noCommit,
      opts: { dryRun: opts.dryRun },
    });

    process.stdout.write(`[tspr apply-fix] ${result.message}\n`);
    if (result.files.length > 0) {
      process.stdout.write(`  Files modified: ${result.files.join(', ')}\n`);
    }
    if (result.commitSha) {
      process.stdout.write(`  Commit: ${result.commitSha.slice(0, 12)}\n`);
    }
    if (!opts.noCommit && result.branch && result.branch !== '(no-commit mode)') {
      process.stdout.write(`  Branch: ${result.branch}\n`);
      process.stdout.write(`  Next: tspr push-pr or: cd ${resolvedProject} && gh pr create\n`);
    }
    return 0;
  } catch (err) {
    if (err instanceof GitOpsError) {
      process.stderr.write(`[tspr apply-fix] Error (${err.code}): ${err.detail}\n`);
    } else {
      process.stderr.write(`[tspr apply-fix] Unexpected error: ${String(err)}\n`);
    }
    return 1;
  }
}
