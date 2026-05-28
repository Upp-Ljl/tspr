/**
 * tests/dashboard/changes.test.ts
 *
 * Tests for computeProjectChanges() in src/dashboard/changes.ts.
 * Covers: <2 runs → null; newly broken; newly recovered; still failing;
 * comparedRunIds shape; scenarioId stability.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { computeProjectChanges } from '../../src/dashboard/changes.js';
import { computeStableIssueId } from '../../src/dashboard/issues.js';
import type { Db, Stmt } from '../../src/lib/db.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface RunRow {
  id: string;
  project_path: string | null;
  started_at: string;
  status: string;
}

interface TestResultsShape {
  failures?: Array<{ testId: string; testName: string }>;
  passes?: Array<{ testId: string; testName: string }>;
}

/**
 * Minimal fake Db that serves the specific query shape used by computeProjectChanges:
 *   SELECT id, project_path, started_at, status FROM runs
 *   WHERE project_path = ? AND status != 'in-progress'
 *   ORDER BY started_at DESC LIMIT 2
 */
function makeRunDb(runs: RunRow[]): Db {
  const makeStmt = (sql: string): Stmt => ({
    run: () => ({ changes: 0, lastInsertRowid: 0 }),
    get: () => undefined,
    all: (...args: unknown[]) => {
      // Only handle the runs query
      if (/FROM\s+runs/i.test(sql)) {
        const projectPath = args[0] as string;
        return runs
          .filter((r) => r.project_path === projectPath && r.status !== 'in-progress')
          .sort((a, b) => b.started_at.localeCompare(a.started_at))
          .slice(0, 2) as unknown[];
      }
      return [];
    },
    iterate: () => [][Symbol.iterator](),
  });

  return {
    exec: () => {},
    prepare: (sql: string) => makeStmt(sql),
    transaction: <R>(fn: () => R) => fn(),
    close: () => {},
  };
}

/** Write test_results.json to a temp ~/.tspr/runs/<runId>/ directory. */
function writeArchivedResults(runId: string, results: TestResultsShape): string {
  const dir = path.join(os.homedir(), '.tspr', 'runs', runId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'test_results.json');
  fs.writeFileSync(filePath, JSON.stringify(results), 'utf-8');
  return filePath;
}

/** Write test_results.json to <projectPath>/.tspr/ (current run location). */
function writeCurrentResults(projectPath: string, results: TestResultsShape): void {
  const dir = path.join(projectPath, '.tspr');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'test_results.json'), JSON.stringify(results), 'utf-8');
}

/** Create a temp project directory. */
function mkTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tspr-changes-test-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  return dir;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('computeProjectChanges', () => {
  const cleanupPaths: string[] = [];
  const cleanupRunIds: string[] = [];

  afterEach(() => {
    for (const p of cleanupPaths.splice(0)) {
      try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    for (const runId of cleanupRunIds.splice(0)) {
      const dir = path.join(os.homedir(), '.tspr', 'runs', runId);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  function trackDir(p: string): string { cleanupPaths.push(p); return p; }
  function trackRun(id: string): string { cleanupRunIds.push(id); return id; }
  function uid(): string { return crypto.randomUUID(); }

  // ── CHANGES-001: <2 runs → comparedRunIds: null, empty arrays ────────────
  it('CHANGES-001: returns comparedRunIds: null when fewer than 2 completed runs', async () => {
    const projectPath = '/nonexistent/project/abc';
    const db = makeRunDb([]); // no runs at all
    const result = await computeProjectChanges(db, projectPath);

    expect(result.comparedRunIds).toBeNull();
    expect(result.newlyBroken).toEqual([]);
    expect(result.newlyRecovered).toEqual([]);
    expect(result.stillFailing).toEqual([]);
    expect(result.projectPath).toBe(projectPath);
  });

  // ── CHANGES-002: exactly 1 run → still null ───────────────────────────────
  it('CHANGES-002: returns comparedRunIds: null when only 1 completed run exists', async () => {
    const projectPath = trackDir(mkTempProject());
    const runId = trackRun(uid());
    const db = makeRunDb([
      { id: runId, project_path: projectPath, started_at: '2026-05-26T10:00:00Z', status: 'ok' },
    ]);
    const result = await computeProjectChanges(db, projectPath);
    expect(result.comparedRunIds).toBeNull();
  });

  // ── CHANGES-003: newlyBroken when test passes prev, fails current ─────────
  it('CHANGES-003: newlyBroken contains tests that fail in current but passed in previous', async () => {
    const projectPath = trackDir(mkTempProject());
    const currentRunId = trackRun(uid());
    const previousRunId = trackRun(uid());

    const db = makeRunDb([
      { id: currentRunId, project_path: projectPath, started_at: '2026-05-26T12:00:00Z', status: 'ok' },
      { id: previousRunId, project_path: projectPath, started_at: '2026-05-26T10:00:00Z', status: 'ok' },
    ]);

    // Current run: test-a is failing
    writeCurrentResults(projectPath, {
      failures: [{ testId: 'test-a', testName: 'Test A' }],
      passes: [],
    });
    // Previous run: test-a was passing
    writeArchivedResults(previousRunId, {
      failures: [],
      passes: [{ testId: 'test-a', testName: 'Test A' }],
    });

    const result = await computeProjectChanges(db, projectPath);

    expect(result.comparedRunIds).toEqual({ current: currentRunId, previous: previousRunId });
    expect(result.newlyBroken).toHaveLength(1);
    expect(result.newlyBroken[0].title).toBe('Test A');
    expect(result.newlyBroken[0].runId).toBe(currentRunId);
    expect(result.newlyRecovered).toHaveLength(0);
    expect(result.stillFailing).toHaveLength(0);
  });

  // ── CHANGES-004: newlyRecovered when test fails prev, passes current ──────
  it('CHANGES-004: newlyRecovered contains tests that passed in current but failed in previous', async () => {
    const projectPath = trackDir(mkTempProject());
    const currentRunId = trackRun(uid());
    const previousRunId = trackRun(uid());

    const db = makeRunDb([
      { id: currentRunId, project_path: projectPath, started_at: '2026-05-26T12:00:00Z', status: 'ok' },
      { id: previousRunId, project_path: projectPath, started_at: '2026-05-26T10:00:00Z', status: 'ok' },
    ]);

    writeCurrentResults(projectPath, {
      failures: [],
      passes: [{ testId: 'test-b', testName: 'Test B' }],
    });
    writeArchivedResults(previousRunId, {
      failures: [{ testId: 'test-b', testName: 'Test B' }],
      passes: [],
    });

    const result = await computeProjectChanges(db, projectPath);

    expect(result.newlyRecovered).toHaveLength(1);
    expect(result.newlyRecovered[0].title).toBe('Test B');
    expect(result.newlyBroken).toHaveLength(0);
    expect(result.stillFailing).toHaveLength(0);
  });

  // ── CHANGES-005: stillFailing when test fails in both runs ───────────────
  it('CHANGES-005: stillFailing contains tests that fail in both current and previous', async () => {
    const projectPath = trackDir(mkTempProject());
    const currentRunId = trackRun(uid());
    const previousRunId = trackRun(uid());

    const db = makeRunDb([
      { id: currentRunId, project_path: projectPath, started_at: '2026-05-26T12:00:00Z', status: 'ok' },
      { id: previousRunId, project_path: projectPath, started_at: '2026-05-26T10:00:00Z', status: 'ok' },
    ]);

    writeCurrentResults(projectPath, {
      failures: [{ testId: 'test-c', testName: 'Test C' }],
    });
    writeArchivedResults(previousRunId, {
      failures: [{ testId: 'test-c', testName: 'Test C' }],
    });

    const result = await computeProjectChanges(db, projectPath);

    expect(result.stillFailing).toHaveLength(1);
    expect(result.stillFailing[0].title).toBe('Test C');
    expect(result.stillFailing[0].runsCount).toBeGreaterThanOrEqual(2);
    expect(result.newlyBroken).toHaveLength(0);
    expect(result.newlyRecovered).toHaveLength(0);
  });

  // ── CHANGES-006: scenarioId is stable hash matching computeStableIssueId ─
  it('CHANGES-006: scenarioId matches computeStableIssueId(testId, projectPath)', async () => {
    const projectPath = trackDir(mkTempProject());
    const currentRunId = trackRun(uid());
    const previousRunId = trackRun(uid());

    const db = makeRunDb([
      { id: currentRunId, project_path: projectPath, started_at: '2026-05-26T12:00:00Z', status: 'ok' },
      { id: previousRunId, project_path: projectPath, started_at: '2026-05-26T10:00:00Z', status: 'ok' },
    ]);

    writeCurrentResults(projectPath, {
      failures: [{ testId: 'stable-test-id', testName: 'Stable Test' }],
    });
    writeArchivedResults(previousRunId, {
      passes: [{ testId: 'stable-test-id', testName: 'Stable Test' }],
    });

    const result = await computeProjectChanges(db, projectPath);
    expect(result.newlyBroken).toHaveLength(1);

    const expectedId = computeStableIssueId('stable-test-id', projectPath);
    expect(result.newlyBroken[0].scenarioId).toBe(expectedId);
    expect(expectedId.length).toBe(16);
  });

  // ── CHANGES-007: mixed scenario — broken + recovered + still failing ──────
  it('CHANGES-007: handles mixed scenario with broken + recovered + still failing', async () => {
    const projectPath = trackDir(mkTempProject());
    const currentRunId = trackRun(uid());
    const previousRunId = trackRun(uid());

    const db = makeRunDb([
      { id: currentRunId, project_path: projectPath, started_at: '2026-05-26T12:00:00Z', status: 'ok' },
      { id: previousRunId, project_path: projectPath, started_at: '2026-05-26T10:00:00Z', status: 'ok' },
    ]);

    // current: test-a broken, test-b passing (recovered), test-c still failing
    writeCurrentResults(projectPath, {
      failures: [
        { testId: 'test-a', testName: 'A' },
        { testId: 'test-c', testName: 'C' },
      ],
      passes: [{ testId: 'test-b', testName: 'B' }],
    });
    // previous: test-a passing, test-b failing, test-c failing
    writeArchivedResults(previousRunId, {
      failures: [
        { testId: 'test-b', testName: 'B' },
        { testId: 'test-c', testName: 'C' },
      ],
      passes: [{ testId: 'test-a', testName: 'A' }],
    });

    const result = await computeProjectChanges(db, projectPath);

    expect(result.newlyBroken).toHaveLength(1);
    expect(result.newlyBroken[0].title).toBe('A');

    expect(result.newlyRecovered).toHaveLength(1);
    expect(result.newlyRecovered[0].title).toBe('B');

    expect(result.stillFailing).toHaveLength(1);
    expect(result.stillFailing[0].title).toBe('C');
  });

  // ── CHANGES-008: in-progress runs are excluded from the 2-run window ──────
  it('CHANGES-008: in-progress runs are excluded, only completed runs count', async () => {
    const projectPath = trackDir(mkTempProject());
    const runId = trackRun(uid());
    const inProgressRunId = trackRun(uid());

    // One completed run + one in-progress → should still return null (< 2 completed)
    const db = makeRunDb([
      { id: inProgressRunId, project_path: projectPath, started_at: '2026-05-26T13:00:00Z', status: 'in-progress' },
      { id: runId, project_path: projectPath, started_at: '2026-05-26T10:00:00Z', status: 'ok' },
    ]);

    const result = await computeProjectChanges(db, projectPath);
    expect(result.comparedRunIds).toBeNull();
  });
});
