/**
 * src/dashboard/compare.ts
 *
 * Diff two tspr runs: which tests were fixed, which broke new, which are
 * still failing.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TestOutcomeRow {
  test_id: string;
  test_name: string;
  status: string; // 'passed' | 'failed' | 'skipped'
}

export interface CompareDb {
  getTestOutcomesForRun: (runId: string) => TestOutcomeRow[];
  runExists: (runId: string) => boolean;
}

export interface CompareResult {
  runA: string;
  runB: string;
  /** Tests that were failing in A but passing in B (fixed) */
  fixed: TestOutcomeRow[];
  /** Tests that were passing (or not present) in A but failing in B (new failures) */
  newFailures: TestOutcomeRow[];
  /** Tests that were failing in both A and B (still broken) */
  stillFailing: TestOutcomeRow[];
  /** Tests that passed in both */
  passingBoth: TestOutcomeRow[];
  error?: string;
}

// ─── Core diff ────────────────────────────────────────────────────────────────

/**
 * Compare two runs. runA = "before" (older), runB = "after" (newer).
 *
 * Returns categorized lists suitable for display.
 */
export function compareRuns(
  db: CompareDb,
  runA: string,
  runB: string,
): CompareResult {
  if (!db.runExists(runA)) {
    return { runA, runB, fixed: [], newFailures: [], stillFailing: [], passingBoth: [], error: `Run ${runA} not found` };
  }
  if (!db.runExists(runB)) {
    return { runA, runB, fixed: [], newFailures: [], stillFailing: [], passingBoth: [], error: `Run ${runB} not found` };
  }

  const outcomesA = db.getTestOutcomesForRun(runA);
  const outcomesB = db.getTestOutcomesForRun(runB);

  // Build maps: test_id → status
  const mapA = new Map<string, TestOutcomeRow>();
  const mapB = new Map<string, TestOutcomeRow>();

  for (const t of outcomesA) mapA.set(t.test_id, t);
  for (const t of outcomesB) mapB.set(t.test_id, t);

  const fixed: TestOutcomeRow[] = [];
  const newFailures: TestOutcomeRow[] = [];
  const stillFailing: TestOutcomeRow[] = [];
  const passingBoth: TestOutcomeRow[] = [];

  // Tests in B
  for (const [testId, rowB] of mapB) {
    const rowA = mapA.get(testId);
    const wasFailingA = rowA?.status === 'failed';
    const isFailingB = rowB.status === 'failed';

    if (!isFailingB && wasFailingA) {
      fixed.push(rowB);
    } else if (isFailingB && !wasFailingA) {
      newFailures.push(rowB);
    } else if (isFailingB && wasFailingA) {
      stillFailing.push(rowB);
    } else if (!isFailingB && !wasFailingA) {
      passingBoth.push(rowB);
    }
  }

  // Tests that existed in A but not B → treat as no longer tested, skip

  return { runA, runB, fixed, newFailures, stillFailing, passingBoth };
}
