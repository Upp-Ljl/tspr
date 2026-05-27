/**
 * src/dashboard/issues.ts
 *
 * Cross-run top-issues aggregator.
 * Reads from the runs + test_results tables and returns the top N
 * issues ranked by severity (failure > warning), consecutive-run
 * frequency, and recency.
 */

import { createHash } from 'node:crypto';

// ─── Stable issue ID ─────────────────────────────────────────────────────────

/**
 * Compute a stable 16-char hex issue ID from testId + projectPath.
 * Stable: same inputs → same output across runs and restarts.
 */
export function computeStableIssueId(testId: string, projectPath: string): string {
  return createHash('sha256')
    .update(testId + '\x00' + (projectPath ?? ''))
    .digest('hex')
    .slice(0, 16);
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface IssueEntry {
  testId: string;
  /** Stable 16-char hex hash of testId + projectPath. Usable as tspr apply-fix <issueId> */
  issueId: string;
  title: string;
  projectPath: string | null;
  /** Number of consecutive runs this test has been failing */
  consecutiveFailures: number;
  /** ISO timestamp of the most recent failure */
  lastFailedAt: string;
  /** Stack trace from last failure */
  stack: string | null;
  /** Suggested fix region from last failure (JSON string or null) */
  suggestedFixRegion: SuggestedFixRegion | null;
  /** Suggested patch (unified diff) from last failure */
  suggestedPatch: string | null;
  /** run_id of the most recent run that had this failure */
  lastRunId: string;
  /** Whether a suggestedPatch is available (for UI show/hide) */
  hasPatch: boolean;
}

/** Extended IssueEntry exported for apply-fix CLI. Includes all fields. */
export type FixedIssueEntry = IssueEntry;

export interface SuggestedFixRegion {
  file: string;
  lineStart: number;
  lineEnd: number;
  why: string;
}

export interface IssueAggregatorDb {
  /** Returns all runs, newest first. Columns: id, project_path, started_at, status */
  getRunsForIssues: () => Array<{
    id: string;
    project_path: string | null;
    started_at: string;
    status: string;
  }>;
  /** Returns all failed test results for a run. */
  getFailedResultsForRun: (runId: string) => Array<{
    test_id: string;
    test_name: string;
    error_message: string | null;
    suggested_fix_region: string | null;
    suggested_patch: string | null;
  }>;
}

// ─── Core aggregation ─────────────────────────────────────────────────────────

/**
 * Aggregate top issues across all runs.
 *
 * Algorithm:
 * 1. Collect all failed test_results grouped by test_id
 * 2. For each test_id, count consecutive failures in most recent N runs for
 *    that project
 * 3. Rank: consecutiveFailures desc, then lastFailedAt desc
 */
export function aggregateTopIssues(
  db: IssueAggregatorDb,
  limit = 20,
): IssueEntry[] {
  const runs = db.getRunsForIssues();
  if (runs.length === 0) return [];

  // Map: testId → aggregated data
  const byTestId = new Map<string, {
    testId: string;
    title: string;
    projectPath: string | null;
    failureRunIds: string[];        // ordered newest-first
    lastFailedAt: string;
    stack: string | null;
    suggestedFixRegion: SuggestedFixRegion | null;
    suggestedPatch: string | null;
    lastRunId: string;
  }>();

  // Iterate runs newest-first and collect failures
  for (const run of runs) {
    if (run.status === 'in-progress') continue;
    const failures = db.getFailedResultsForRun(run.id);
    for (const f of failures) {
      const existing = byTestId.get(f.test_id);
      if (!existing) {
        let fixRegion: SuggestedFixRegion | null = null;
        if (f.suggested_fix_region) {
          try { fixRegion = JSON.parse(f.suggested_fix_region) as SuggestedFixRegion; } catch { /* ignore */ }
        }
        byTestId.set(f.test_id, {
          testId: f.test_id,
          title: f.test_name,
          projectPath: run.project_path,
          failureRunIds: [run.id],
          lastFailedAt: run.started_at,
          stack: f.error_message,
          suggestedFixRegion: fixRegion,
          suggestedPatch: f.suggested_patch ?? null,
          lastRunId: run.id,
        });
      } else {
        existing.failureRunIds.push(run.id);
      }
    }
  }

  // Calculate consecutive failures: walk runs for same project newest-first,
  // count how many in a row have this test failing
  const entries: IssueEntry[] = [];
  for (const [, issue] of byTestId) {
    // Get runs for this project in order
    const projectRuns = runs.filter(
      (r) => r.project_path === issue.projectPath && r.status !== 'in-progress',
    );
    let consecutive = 0;
    const failSet = new Set(issue.failureRunIds);
    for (const run of projectRuns) {
      if (failSet.has(run.id)) {
        consecutive++;
      } else {
        break; // stop counting on first non-failure
      }
    }

    const issueId = computeStableIssueId(issue.testId, issue.projectPath ?? '');
    entries.push({
      testId: issue.testId,
      issueId,
      title: issue.title,
      projectPath: issue.projectPath,
      consecutiveFailures: Math.max(consecutive, 1),
      lastFailedAt: issue.lastFailedAt,
      stack: issue.stack,
      suggestedFixRegion: issue.suggestedFixRegion,
      suggestedPatch: issue.suggestedPatch,
      hasPatch: issue.suggestedPatch != null,
      lastRunId: issue.lastRunId,
    });
  }

  // Sort: consecutive desc, then recency desc
  entries.sort((a, b) => {
    if (b.consecutiveFailures !== a.consecutiveFailures) {
      return b.consecutiveFailures - a.consecutiveFailures;
    }
    return b.lastFailedAt.localeCompare(a.lastFailedAt);
  });

  return entries.slice(0, limit);
}
