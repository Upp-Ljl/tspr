/**
 * tests/dashboard/issues.test.ts
 *
 * Unit tests for src/dashboard/issues.ts — top-issues aggregator.
 */

import { describe, it, expect } from 'vitest';
import { aggregateTopIssues, type IssueAggregatorDb } from '../../src/dashboard/issues.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDb(
  runs: Array<{ id: string; project_path: string | null; started_at: string; status: string }>,
  failuresByRun: Record<string, Array<{ test_id: string; test_name: string; error_message: string | null; suggested_fix_region: string | null; suggested_patch: string | null }>>,
): IssueAggregatorDb {
  return {
    getRunsForIssues: () => runs,
    getFailedResultsForRun: (runId) => failuresByRun[runId] ?? [],
  };
}

const NOW = new Date('2026-05-26T12:00:00Z').toISOString();
function daysAgo(n: number): string {
  return new Date(new Date(NOW).getTime() - n * 86400000).toISOString();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('aggregateTopIssues', () => {
  it('returns empty array when no runs', () => {
    const db = makeDb([], {});
    expect(aggregateTopIssues(db)).toEqual([]);
  });

  it('returns empty array when all runs pass', () => {
    const db = makeDb(
      [{ id: 'r1', project_path: '/proj', started_at: daysAgo(1), status: 'ok' }],
      { r1: [] },
    );
    expect(aggregateTopIssues(db)).toEqual([]);
  });

  it('aggregates failures from a single run', () => {
    const db = makeDb(
      [{ id: 'r1', project_path: '/proj', started_at: daysAgo(1), status: 'ok' }],
      {
        r1: [
          { test_id: 'test-a', test_name: 'Test A', error_message: 'fail', suggested_fix_region: null, suggested_patch: null },
          { test_id: 'test-b', test_name: 'Test B', error_message: 'fail2', suggested_fix_region: null, suggested_patch: null },
        ],
      },
    );
    const issues = aggregateTopIssues(db);
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.testId)).toContain('test-a');
    expect(issues.map((i) => i.testId)).toContain('test-b');
  });

  it('counts consecutive failures correctly', () => {
    // 3 runs newest-first; test-a fails in all 3 → consecutiveFailures = 3
    const db = makeDb(
      [
        { id: 'r3', project_path: '/p', started_at: daysAgo(1), status: 'ok' },
        { id: 'r2', project_path: '/p', started_at: daysAgo(2), status: 'ok' },
        { id: 'r1', project_path: '/p', started_at: daysAgo(3), status: 'ok' },
      ],
      {
        r3: [{ test_id: 'test-a', test_name: 'A', error_message: 'e', suggested_fix_region: null, suggested_patch: null }],
        r2: [{ test_id: 'test-a', test_name: 'A', error_message: 'e', suggested_fix_region: null, suggested_patch: null }],
        r1: [{ test_id: 'test-a', test_name: 'A', error_message: 'e', suggested_fix_region: null, suggested_patch: null }],
      },
    );
    const issues = aggregateTopIssues(db);
    expect(issues).toHaveLength(1);
    expect(issues[0].consecutiveFailures).toBe(3);
  });

  it('resets consecutive count when a run passes', () => {
    // r3 and r2 fail, r1 passes → consecutive = 2 (counting newest streak)
    const db = makeDb(
      [
        { id: 'r3', project_path: '/p', started_at: daysAgo(1), status: 'ok' },
        { id: 'r2', project_path: '/p', started_at: daysAgo(2), status: 'ok' },
        { id: 'r1', project_path: '/p', started_at: daysAgo(3), status: 'ok' },
      ],
      {
        r3: [{ test_id: 'test-a', test_name: 'A', error_message: 'e', suggested_fix_region: null, suggested_patch: null }],
        r2: [{ test_id: 'test-a', test_name: 'A', error_message: 'e', suggested_fix_region: null, suggested_patch: null }],
        r1: [], // passing
      },
    );
    const issues = aggregateTopIssues(db);
    expect(issues).toHaveLength(1);
    expect(issues[0].consecutiveFailures).toBe(2);
  });

  it('sorts by consecutive failures descending', () => {
    // test-a fails 3 times, test-b fails 1 time → a should come first
    const db = makeDb(
      [
        { id: 'r3', project_path: '/p', started_at: daysAgo(1), status: 'ok' },
        { id: 'r2', project_path: '/p', started_at: daysAgo(2), status: 'ok' },
        { id: 'r1', project_path: '/p', started_at: daysAgo(3), status: 'ok' },
      ],
      {
        r3: [
          { test_id: 'test-a', test_name: 'A', error_message: 'e', suggested_fix_region: null, suggested_patch: null },
          { test_id: 'test-b', test_name: 'B', error_message: 'e', suggested_fix_region: null, suggested_patch: null },
        ],
        r2: [{ test_id: 'test-a', test_name: 'A', error_message: 'e', suggested_fix_region: null, suggested_patch: null }],
        r1: [{ test_id: 'test-a', test_name: 'A', error_message: 'e', suggested_fix_region: null, suggested_patch: null }],
      },
    );
    const issues = aggregateTopIssues(db);
    expect(issues[0].testId).toBe('test-a');
    expect(issues[0].consecutiveFailures).toBe(3);
    expect(issues[1].testId).toBe('test-b');
    expect(issues[1].consecutiveFailures).toBe(1);
  });

  it('respects limit parameter', () => {
    const db = makeDb(
      [{ id: 'r1', project_path: '/p', started_at: daysAgo(1), status: 'ok' }],
      {
        r1: [
          { test_id: 't1', test_name: 'T1', error_message: null, suggested_fix_region: null, suggested_patch: null },
          { test_id: 't2', test_name: 'T2', error_message: null, suggested_fix_region: null, suggested_patch: null },
          { test_id: 't3', test_name: 'T3', error_message: null, suggested_fix_region: null, suggested_patch: null },
        ],
      },
    );
    expect(aggregateTopIssues(db, 2)).toHaveLength(2);
    expect(aggregateTopIssues(db, 1)).toHaveLength(1);
  });

  it('parses suggestedFixRegion from JSON string', () => {
    const fixRegion = { file: '/src/app.ts', lineStart: 10, lineEnd: 20, why: 'bug here' };
    const db = makeDb(
      [{ id: 'r1', project_path: '/p', started_at: daysAgo(1), status: 'ok' }],
      {
        r1: [{
          test_id: 'test-a', test_name: 'A', error_message: 'err',
          suggested_fix_region: JSON.stringify(fixRegion),
          suggested_patch: 'diff ...',
        }],
      },
    );
    const issues = aggregateTopIssues(db);
    expect(issues[0].suggestedFixRegion).toEqual(fixRegion);
    expect(issues[0].suggestedPatch).toBe('diff ...');
  });

  it('skips in-progress runs', () => {
    const db = makeDb(
      [{ id: 'r1', project_path: '/p', started_at: daysAgo(1), status: 'in-progress' }],
      { r1: [{ test_id: 'test-a', test_name: 'A', error_message: 'e', suggested_fix_region: null, suggested_patch: null }] },
    );
    expect(aggregateTopIssues(db)).toHaveLength(0);
  });
});
