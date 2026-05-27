/**
 * src/git-ops/index.ts
 *
 * Git operations helpers for tspr local-advantage features.
 * All operations target the USER'S project directory, never the tspr repo itself.
 *
 * Safety invariant: rejectTsprRepo(targetDir) must be called before any git op.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';

const execFileAsync = promisify(execFile);

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface GitOpsOptions {
  /** If true, skip all git operations but still write files */
  dryRun?: boolean;
  /** If true, skip writing files too — just report what would happen */
  check?: boolean;
}

export interface ApplyPatchResult {
  applied: boolean;
  branch: string;
  commitSha?: string;
  files: string[];
  message: string;
  dryRun: boolean;
  conflicts?: string[];
}

export interface PushPrResult {
  prUrl?: string;
  gh_missing?: boolean;
  branch: string;
  error?: string;
}

export interface MergeLocalResult {
  merged: boolean;
  branch: string;
  base: string;
  conflicts?: string[];
  commitSha?: string;
}

// ─── Safety ────────────────────────────────────────────────────────────────────

/** Detect the tspr repo root to reject operations against it */
const TSPR_REPO_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '..', '..', '..',
).replace(/\\/g, '/');

export function rejectTsprRepo(targetDir: string): void {
  const norm = path.resolve(targetDir).replace(/\\/g, '/');
  const tsprNorm = TSPR_REPO_ROOT.replace(/\\/g, '/');
  if (norm === tsprNorm || norm.startsWith(tsprNorm + '/') || norm.startsWith(tsprNorm + '\\')) {
    throw new GitOpsError(
      'REJECT_TSPR_REPO',
      `Refusing to run git operations against the tspr repo itself (${targetDir}). ` +
      `Always pass the TARGET project path.`,
    );
  }
}

// ─── Error ─────────────────────────────────────────────────────────────────────

export type GitOpsErrorCode =
  | 'REJECT_TSPR_REPO'
  | 'NOT_A_GIT_REPO'
  | 'PATCH_CHECK_FAILED'
  | 'PATCH_APPLY_FAILED'
  | 'BRANCH_CREATE_FAILED'
  | 'COMMIT_FAILED'
  | 'GH_NOT_FOUND'
  | 'PR_CREATE_FAILED'
  | 'MERGE_CONFLICT'
  | 'MERGE_FAILED'
  | 'CHECKOUT_FAILED';

export class GitOpsError extends Error {
  code: GitOpsErrorCode;
  detail: string;
  constructor(code: GitOpsErrorCode, detail: string) {
    super(`[git-ops] ${code}: ${detail}`);
    this.name = 'GitOpsError';
    this.code = code;
    this.detail = detail;
  }
}

// ─── Low-level helpers ─────────────────────────────────────────────────────────

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync('git', args, { cwd, timeout: 30_000 });
    return { stdout: result.stdout.trim(), stderr: (result.stderr ?? '').trim() };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    throw new Error(`git ${args[0]} failed: ${e.stderr || e.message || String(err)}`);
  }
}

async function gitRevParse(cwd: string): Promise<string> {
  try {
    const { stdout } = await git(cwd, ['rev-parse', '--show-toplevel']);
    return stdout;
  } catch {
    throw new GitOpsError('NOT_A_GIT_REPO', `${cwd} is not inside a git repository`);
  }
}

async function gitCurrentSha(cwd: string): Promise<string> {
  const { stdout } = await git(cwd, ['rev-parse', 'HEAD']);
  return stdout;
}

// ─── Apply patch ───────────────────────────────────────────────────────────────

export interface ApplyPatchInput {
  /** Absolute path to the target project (NOT the tspr repo) */
  projectPath: string;
  /** Unified diff string to apply */
  patch: string;
  /** Short issue id (used in branch name) */
  issueId: string;
  /** Human-readable test title (used in commit message) */
  testTitle: string;
  /** Branch to create. If omitted, uses tspr/fix-<issueId> */
  branch?: string;
  /** If true, writes the patch to a tmp file but skips git branch/commit */
  noCommit?: boolean;
  opts?: GitOpsOptions;
}

export async function applyPatch(input: ApplyPatchInput): Promise<ApplyPatchResult> {
  const { projectPath, patch, issueId, testTitle, noCommit = false } = input;
  const opts = input.opts ?? {};
  const dryRun = opts.dryRun ?? false;

  rejectTsprRepo(projectPath);
  await gitRevParse(projectPath); // throws NOT_A_GIT_REPO if not git

  const branchName = input.branch ?? `tspr/fix-${issueId.slice(0, 12)}`;

  if (dryRun) {
    return {
      applied: false,
      branch: branchName,
      files: [],
      message: `[dry-run] would apply patch and create branch ${branchName}`,
      dryRun: true,
    };
  }

  // Write patch to temp file
  const tmpPatch = path.join(projectPath, `.tspr-patch-${issueId.slice(0, 8)}.patch`);
  try {
    fs.writeFileSync(tmpPatch, patch, 'utf-8');

    // Check patch applies cleanly first
    try {
      await git(projectPath, ['apply', '--check', tmpPatch]);
    } catch (err) {
      const msg = String(err);
      throw new GitOpsError('PATCH_CHECK_FAILED', msg);
    }

    if (noCommit) {
      // Just apply the patch, no git branch/commit
      try {
        await git(projectPath, ['apply', tmpPatch]);
      } catch (err) {
        throw new GitOpsError('PATCH_APPLY_FAILED', String(err));
      }

      // Get list of affected files
      let files: string[] = [];
      try {
        const { stdout } = await git(projectPath, ['diff', '--name-only']);
        files = stdout.split('\n').filter(Boolean);
      } catch { /* ignore */ }

      return {
        applied: true,
        branch: '(no-commit mode)',
        files,
        message: `Patch applied (--no-commit mode). Files modified: ${files.join(', ')}`,
        dryRun: false,
      };
    }

    // Create branch off current HEAD
    try {
      await git(projectPath, ['checkout', '-b', branchName]);
    } catch (err) {
      throw new GitOpsError('BRANCH_CREATE_FAILED', String(err));
    }

    // Apply patch
    try {
      await git(projectPath, ['apply', tmpPatch]);
    } catch (err) {
      // Roll back branch creation
      try { await git(projectPath, ['checkout', '-']); } catch { /* ignore */ }
      try { await git(projectPath, ['branch', '-D', branchName]); } catch { /* ignore */ }
      throw new GitOpsError('PATCH_APPLY_FAILED', String(err));
    }

    // Get list of modified files
    let files: string[] = [];
    try {
      const { stdout } = await git(projectPath, ['diff', '--cached', '--name-only']);
      if (!stdout) {
        const { stdout: s2 } = await git(projectPath, ['diff', '--name-only']);
        files = s2.split('\n').filter(Boolean);
      } else {
        files = stdout.split('\n').filter(Boolean);
      }
    } catch { /* ignore */ }

    // Stage + commit
    try {
      await git(projectPath, ['add', '-A']);
      const commitMsg = `fix: tspr issue ${issueId.slice(0, 12)} — ${testTitle.slice(0, 72)}`;
      await git(projectPath, ['commit', '-m', commitMsg]);
    } catch (err) {
      throw new GitOpsError('COMMIT_FAILED', String(err));
    }

    let commitSha: string | undefined;
    try {
      commitSha = await gitCurrentSha(projectPath);
    } catch { /* ignore */ }

    return {
      applied: true,
      branch: branchName,
      commitSha,
      files,
      message: `Patch applied and committed to branch ${branchName} (${commitSha?.slice(0, 8) ?? '?'})`,
      dryRun: false,
    };
  } finally {
    try { fs.unlinkSync(tmpPatch); } catch { /* ignore */ }
  }
}

// ─── Push PR ───────────────────────────────────────────────────────────────────

export async function pushPr(input: {
  projectPath: string;
  branch: string;
  base?: string;
  title?: string;
  opts?: GitOpsOptions;
}): Promise<PushPrResult> {
  const { projectPath, branch, base = 'main', title } = input;
  const opts = input.opts ?? {};

  rejectTsprRepo(projectPath);

  if (opts.dryRun) {
    return { branch, prUrl: undefined, gh_missing: false };
  }

  // Check gh is available
  try {
    await execFileAsync('gh', ['--version'], { timeout: 5000 });
  } catch {
    return { branch, gh_missing: true };
  }

  // Push branch first
  try {
    await git(projectPath, ['push', '-u', 'origin', branch]);
  } catch (err) {
    throw new GitOpsError('PR_CREATE_FAILED', `Push failed: ${String(err)}`);
  }

  // Create PR
  try {
    const args = ['pr', 'create', '--base', base, '--head', branch,
      '--title', title ?? `fix: tspr auto-fix on ${branch}`,
      '--body', 'Auto-generated fix from tspr local agent.'];
    const result = await execFileAsync('gh', args, { cwd: projectPath, timeout: 30_000 });
    const prUrl = result.stdout.trim();
    return { branch, prUrl };
  } catch (err) {
    throw new GitOpsError('PR_CREATE_FAILED', String(err));
  }
}

// ─── Merge local ───────────────────────────────────────────────────────────────

export async function mergeLocal(input: {
  projectPath: string;
  branch: string;
  base?: string;
  opts?: GitOpsOptions;
}): Promise<MergeLocalResult> {
  const { projectPath, branch, base = 'main' } = input;
  const opts = input.opts ?? {};

  rejectTsprRepo(projectPath);
  await gitRevParse(projectPath);

  if (opts.dryRun) {
    return { merged: false, branch, base };
  }

  // Checkout base
  try {
    await git(projectPath, ['checkout', base]);
  } catch (err) {
    throw new GitOpsError('CHECKOUT_FAILED', String(err));
  }

  // Merge
  try {
    await git(projectPath, ['merge', '--no-ff', branch, '-m', `Merge ${branch} into ${base} (tspr auto-fix)`]);
  } catch (err) {
    const msg = String(err);
    if (msg.includes('CONFLICT')) {
      // Get conflict list
      let conflicts: string[] = [];
      try {
        const { stdout } = await git(projectPath, ['diff', '--name-only', '--diff-filter=U']);
        conflicts = stdout.split('\n').filter(Boolean);
      } catch { /* ignore */ }
      // Abort the merge
      try { await git(projectPath, ['merge', '--abort']); } catch { /* ignore */ }
      throw new GitOpsError('MERGE_CONFLICT', `Conflicts in: ${conflicts.join(', ')}`);
    }
    throw new GitOpsError('MERGE_FAILED', msg);
  }

  let commitSha: string | undefined;
  try { commitSha = await gitCurrentSha(projectPath); } catch { /* ignore */ }

  return { merged: true, branch, base, commitSha };
}
