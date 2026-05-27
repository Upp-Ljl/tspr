/**
 * tests/dashboard/compare.test.ts
 *
 * Unit tests for src/dashboard/compare.ts — two-run diff module.
 */

import { describe, it, expect } from 'vitest';
import { compareRuns, type CompareDb, type TestOutcomeRow } from '../../src/dashboard/compare.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDb(
  runData: Record<string, TestOutcomeRow[]>,
): CompareDb {
  return {
    getTestOutcomesForRun: (runId) => runData[runId] ?? [],
    runExists: (runId) => runId in runData,
  };
}

function passed(testId: string, testName?: string): TestOutcomeRow {
  return { test_id: testId, test_name: testName ?? testId, status: 'passed' };
}

function failed(testId: string, testName?: string): TestOutcomeRow {
  return { test_id: testId, test_name: testName ?? testId, status: 'failed' };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('compareRuns', () => {
  it('returns error if runA does not exist', () => {
    const db = makeDb({ 'r2': [passed('t1')] });
    const result = compareRuns(db, 'r1', 'r2');
    expect(result.error).toMatch(/r1/);
    expect(result.fixed).toHaveLength(0);
  });

  it('returns error if runB does not exist', () => {
    const db = makeDb({ 'r1': [passed('t1')] });
    const result = compareRuns(db, 'r1', 'r2');
    expect(result.error).toMatch(/r2/);
  });

  it('all passing in both → passingBoth, no fixed/new/still', () => {
    const db = makeDb({
      r1: [passed('t1'), passed('t2')],
      r2: [passed('t1'), passed('t2')],
    });
    const result = compareRuns(db, 'r1', 'r2');
    expect(result.fixed).toHaveLength(0);
    expect(result.newFailures).toHaveLength(0);
    expect(result.stillFailing).toHaveLength(0);
    expect(result.passingBoth).toHaveLength(2);
    expect(result.error).toBeUndefined();
  });

  it('test was failing in A and passing in B → fixed', () => {
    const db = makeDb({
      r1: [failed('t1')],
      r2: [passed('t1')],
    });
    const result = compareRuns(db, 'r1', 'r2');
    expect(result.fixed).toHaveLength(1);
    expect(result.fixed[0].test_id).toBe('t1');
    expect(result.newFailures).toHaveLength(0);
    expect(result.stillFailing).toHaveLength(0);
  });

  it('test was passing in A and failing in B → new failure', () => {
    const db = makeDb({
      r1: [passed('t1')],
      r2: [failed('t1')],
    });
    const result = compareRuns(db, 'r1', 'r2');
    expect(result.newFailures).toHaveLength(1);
    expect(result.newFailures[0].test_id).toBe('t1');
    expect(result.fixed).toHaveLength(0);
    expect(result.stillFailing).toHaveLength(0);
  });

  it('test failing in both → stillFailing', () => {
    const db = makeDb({
      r1: [failed('t1')],
      r2: [failed('t1')],
    });
    const result = compareRuns(db, 'r1', 'r2');
    expect(result.stillFailing).toHaveLength(1);
    expect(result.stillFailing[0].test_id).toBe('t1');
    expect(result.fixed).toHaveLength(0);
    expect(result.newFailures).toHaveLength(0);
  });

  it('handles mixed scenario correctly', () => {
    const db = makeDb({
      r1: [failed('old-fail'), passed('old-pass'), failed('still-fail')],
      r2: [passed('old-fail'), failed('new-fail'), failed('still-fail')],
    });
    const result = compareRuns(db, 'r1', 'r2');
    expect(result.fixed.map((t) => t.test_id)).toContain('old-fail');
    expect(result.newFailures.map((t) => t.test_id)).toContain('new-fail');
    expect(result.stillFailing.map((t) => t.test_id)).toContain('still-fail');
  });

  it('new test in B that was not in A and is failing → new failure', () => {
    const db = makeDb({
      r1: [passed('t1')],
      r2: [passed('t1'), failed('t-new')],
    });
    const result = compareRuns(db, 'r1', 'r2');
    expect(result.newFailures.map((t) => t.test_id)).toContain('t-new');
  });

  it('runA === runB → everything passingBoth or stillFailing (idempotent)', () => {
    const db = makeDb({
      r1: [passed('t1'), failed('t2')],
    });
    const result = compareRuns(db, 'r1', 'r1');
    // t1 passes in both → passingBoth; t2 fails in both → stillFailing
    expect(result.passingBoth.map((t) => t.test_id)).toContain('t1');
    expect(result.stillFailing.map((t) => t.test_id)).toContain('t2');
    expect(result.fixed).toHaveLength(0);
    expect(result.newFailures).toHaveLength(0);
  });
});
