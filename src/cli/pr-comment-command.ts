/**
 * src/cli/pr-comment-command.ts
 *
 * CLI subcommand: tspr pr-comment <pr-number> [--repo owner/name]
 *                                             [--run <runId>]
 *                                             [--dry-run]
 *                                             [--projectPath <path>]
 *
 * CLI wiring (for lead to add to src/cli/index.ts):
 *   import { runPrCommentCommand } from './pr-comment-command.js';
 *   case 'pr-comment': return runPrCommentCommand(args);
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';

import { formatPrComment, type FormatCommentInput } from '../pr/format-comment.js';
import { tsprHome } from '../lib/paths.js';
import { openDb, initSchema } from '../lib/db.js';

// ─── Arg parser ──────────────────────────────────────────────────────────────

interface ParsedArgs {
  prNumber: string;
  repo?: string;
  runId?: string;
  dryRun: boolean;
  projectPath: string;
}

function parseArgs(args: string[]): ParsedArgs | null {
  const positionals: string[] = [];
  let repo: string | undefined;
  let runId: string | undefined;
  let dryRun = false;
  let projectPath = process.cwd();

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--repo' && i + 1 < args.length) {
      repo = args[++i];
    } else if (arg === '--run' && i + 1 < args.length) {
      runId = args[++i];
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--projectPath' && i + 1 < args.length) {
      projectPath = args[++i];
    } else if (!arg.startsWith('--')) {
      positionals.push(arg);
    }
    i++;
  }

  const prNumber = positionals[0];
  if (!prNumber) return null;

  return { prNumber, repo, runId, dryRun, projectPath };
}

// ─── test_results.json shape (what .tspr/test_results.json actually looks like) ─

interface TestResultsJson {
  status?: string;
  totalTests?: number;
  passed?: number;
  failed?: number;
  skipped?: number;
  outputPath?: string;
  reportPath?: string;
  warnings?: string[];
  failures?: Array<{
    testId?: string;
    title?: string;
    stack?: string;
    suggestedFixRegion?: {
      file: string;
      lineStart: number;
      lineEnd: number;
      why: string;
    };
    suggestedPatch?: string;
  }>;
}

function readTestResults(filePath: string): TestResultsJson {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot read test results from ${filePath}: ${msg}`);
  }
  try {
    return JSON.parse(raw) as TestResultsJson;
  } catch {
    throw new Error(`test_results.json at ${filePath} is not valid JSON`);
  }
}

// ─── DB lookup ────────────────────────────────────────────────────────────────

interface RunRow {
  id: string;
  tool_name: string;
  project_path: string | null;
  started_at: string;
  completed_at: string | null;
  status: string;
}

function lookupRun(runId: string): RunRow | undefined {
  try {
    const db = openDb();
    initSchema(db);
    const row = db.prepare<RunRow>('SELECT * FROM runs WHERE id = ?').get(runId);
    db.close();
    return row;
  } catch {
    // DB might not exist yet — non-fatal, we just skip metadata enrichment
    return undefined;
  }
}

// ─── gh CLI helper ────────────────────────────────────────────────────────────

function checkGhInstalled(): void {
  try {
    const result = spawnSync('gh', ['--version'], { encoding: 'utf8', shell: true });
    if (result.status !== 0 && result.error) {
      throw result.error;
    }
  } catch {
    throw new Error(
      'gh CLI is not installed or not in PATH.\n' +
        'Install it from https://cli.github.com/ and run `gh auth login`.',
    );
  }
}

function checkGhAuth(): void {
  try {
    const result = spawnSync('gh', ['auth', 'status'], {
      encoding: 'utf8',
      shell: true,
    });
    if (result.status !== 0) {
      throw new Error(
        'gh auth not configured. Run `gh auth login` first.\n' +
          (result.stderr ?? ''),
      );
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('gh auth')) throw err;
    // spawnSync failure — gh not installed (covered by checkGhInstalled)
  }
}

// ─── Main command ─────────────────────────────────────────────────────────────

export async function runPrCommentCommand(args: string[]): Promise<number> {
  const parsed = parseArgs(args);

  if (!parsed) {
    process.stderr.write(
      'Usage: tspr pr-comment <pr-number> [--repo owner/name] [--run <runId>] [--dry-run] [--projectPath <path>]\n',
    );
    return 1;
  }

  const { prNumber, repo, runId, dryRun, projectPath } = parsed;

  // Locate test_results.json
  let resultsPath: string;
  if (runId) {
    resultsPath = path.join(tsprHome(), 'runs', runId, 'test_results.json');
  } else {
    resultsPath = path.join(projectPath, '.tspr', 'test_results.json');
  }

  let results: TestResultsJson;
  try {
    results = readTestResults(resultsPath);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[tspr pr-comment] error: ${msg}\n`);
    return 1;
  }

  // Look up run metadata from DB (best effort)
  let runRow: RunRow | undefined;
  if (runId) {
    runRow = lookupRun(runId);
  }

  // Derive project name from projectPath
  const projectName = path.basename(projectPath) || 'unknown';

  // Build reportUrl / dashboardUrl
  let reportUrl: string | undefined;
  let dashboardUrl: string | undefined;

  if (results.reportPath) {
    // Normalize to file:// URL
    const normalized = results.reportPath.replace(/\\/g, '/');
    reportUrl = normalized.startsWith('/')
      ? `file://${normalized}`
      : `file:///${normalized}`;
  }
  // dashboardUrl would require knowing if the dashboard server is running;
  // for now we skip it (no way to probe without network call in the CLI)

  // Determine status pill
  const total = results.totalTests ?? 0;
  const passed = results.passed ?? 0;
  const failed = results.failed ?? 0;
  const skipped = results.skipped ?? 0;

  let status: FormatCommentInput['status'];
  const rawStatus = results.status;
  if (rawStatus === 'ok' || rawStatus === 'partial' || rawStatus === 'all-failed') {
    status = rawStatus;
  } else if (failed === 0 && total > 0) {
    status = 'ok';
  } else if (failed === total && total > 0) {
    status = 'all-failed';
  } else if (failed > 0) {
    status = 'partial';
  } else {
    status = 'ok';
  }

  // Build failures array
  const failures: FormatCommentInput['failures'] = (results.failures ?? []).map((f) => ({
    testId: f.testId ?? '',
    title: f.title ?? f.testId ?? 'unknown test',
    stack: f.stack,
    suggestedFixRegion: f.suggestedFixRegion,
    suggestedPatch: f.suggestedPatch,
  }));

  // Effective runId
  const effectiveRunId = runId ?? results.outputPath ?? `${projectName}-latest`;

  // Started at — use DB row if available
  const startedAt: Date | string = runRow?.started_at
    ? new Date(runRow.started_at)
    : new Date();

  // Duration: not always in test_results.json — use 0 as fallback
  const durationMs = 0;

  const input: FormatCommentInput = {
    runId: effectiveRunId,
    projectName,
    startedAt,
    durationMs,
    totalTests: total,
    passed,
    failed,
    skipped,
    status,
    failures,
    dashboardUrl,
    reportUrl,
    // provider / modelId not stored in test_results.json yet
  };

  const markdown = formatPrComment(input);

  if (dryRun) {
    const outDir = tsprHome();
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `pr-comment-${prNumber}.md`);
    fs.writeFileSync(outPath, markdown, 'utf8');
    process.stdout.write(outPath + '\n');
    return 0;
  }

  // Real post via gh CLI
  try {
    checkGhInstalled();
    checkGhAuth();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[tspr pr-comment] ${msg}\n`);
    return 1;
  }

  // Write markdown to a temp file
  const tmpFile = path.join(os.tmpdir(), `tspr-pr-comment-${Date.now()}.md`);
  fs.writeFileSync(tmpFile, markdown, 'utf8');

  try {
    const ghArgs = ['pr', 'comment', prNumber, '--body-file', tmpFile];
    if (repo) {
      ghArgs.push('--repo', repo);
    }

    const result = spawnSync('gh', ghArgs, {
      encoding: 'utf8',
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (result.status !== 0) {
      const errMsg = result.stderr ?? result.stdout ?? 'unknown error';
      process.stderr.write(`[tspr pr-comment] gh pr comment failed:\n${errMsg}\n`);
      return 1;
    }

    process.stdout.write(result.stdout ?? '');
    process.stdout.write(`[tspr] Posted comment to PR #${prNumber}\n`);
    return 0;
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // best effort cleanup
    }
  }
}
