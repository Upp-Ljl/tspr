/**
 * src/dashboard/changes.ts
 *
 * Computes "newly broken / newly recovered / still failing" per project
 * by diffing the latest two runs.
 *
 * Data sources:
 *   - `runs` table  — history for the project (limit 2 newest)
 *   - `<projectPath>/.tspr/test_results.json`          — current run results
 *   - `~/.tspr/runs/<runId>/test_results.json`         — previous run results (archived)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Db } from '../lib/db.js';
import { computeStableIssueId } from './issues.js';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface ProjectChanges {
  projectPath: string;
  /** null when fewer than 2 completed runs exist for the project */
  comparedRunIds: { current: string; previous: string } | null;
  /** Tests that passed in the previous run but failed in the current run */
  newlyBroken: Array<{ scenarioId: string; title: string; runId: string }>;
  /** Tests that failed in the previous run but passed in the current run */
  newlyRecovered: Array<{ scenarioId: string; title: string; runId: string }>;
  /** Tests that failed in both the current and previous runs */
  stillFailing: Array<{ scenarioId: string; title: string; runsCount: number }>;
}

// ─── Internal types ───────────────────────────────────────────────────────────

interface RunRow {
  id: string;
  project_path: string | null;
  started_at: string;
  status: string;
}

interface TestResultEntry {
  testId: string;
  testName: string;
  status: 'passed' | 'failed' | 'skipped';
}

interface TestResultsFile {
  failures?: Array<{ testId?: string; testName?: string; [k: string]: unknown }>;
  passes?: Array<{ testId?: string; testName?: string; [k: string]: unknown }>;
  results?: Array<{ testId?: string; testName?: string; status?: string; [k: string]: unknown }>;
  [k: string]: unknown;
}

// ─── File loading ─────────────────────────────────────────────────────────────

/**
 * Load test results from a JSON file.
 * Returns an empty array if the file is missing or unparseable.
 *
 * Supports two common shapes:
 *   { failures: [...], passes: [...] }   — used by AutoPatchReport
 *   { results: [{ testId, status }] }    — flatter shape some runners emit
 */
function loadTestResults(filePath: string): TestResultEntry[] {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw) as TestResultsFile;
    const out: TestResultEntry[] = [];

    // Shape A: { failures, passes }
    if (Array.isArray(data.failures)) {
      for (const f of data.failures) {
        const testId = String(f.testId ?? f['test_id'] ?? '');
        const testName = String(f.testName ?? f['test_name'] ?? testId);
        if (testId) out.push({ testId, testName, status: 'failed' });
      }
    }
    if (Array.isArray(data.passes)) {
      for (const p of data.passes) {
        const testId = String(p.testId ?? p['test_id'] ?? '');
        const testName = String(p.testName ?? p['test_name'] ?? testId);
        if (testId) out.push({ testId, testName, status: 'passed' });
      }
    }

    // Shape B: { results: [{ testId, status }] }
    if (Array.isArray(data.results)) {
      for (const r of data.results) {
        const testId = String(r.testId ?? r['test_id'] ?? '');
        const testName = String(r.testName ?? r['test_name'] ?? testId);
        const status = String(r.status ?? 'skipped') as 'passed' | 'failed' | 'skipped';
        if (testId) out.push({ testId, testName, status });
      }
    }

    return out;
  } catch {
    return [];
  }
}

/**
 * Path to the current run's test_results.json inside the project.
 */
function currentRunResultsPath(projectPath: string): string {
  return path.join(projectPath, '.tspr', 'test_results.json');
}

/**
 * Path to an archived run's test_results.json in ~/.tspr/runs/<runId>/.
 */
function archivedRunResultsPath(runId: string): string {
  return path.join(os.homedir(), '.tspr', 'runs', runId, 'test_results.json');
}

// ─── Diff computation ─────────────────────────────────────────────────────────

/**
 * Build a map of testId → { testName, status } from a result list.
 * When there are duplicate testIds (shouldn't happen in practice), last one wins.
 */
function buildResultMap(results: TestResultEntry[]): Map<string, { testName: string; status: string }> {
  const m = new Map<string, { testName: string; status: string }>();
  for (const r of results) {
    m.set(r.testId, { testName: r.testName, status: r.status });
  }
  return m;
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Reads the latest two completed runs for the given project from SQLite,
 * loads their test_results.json, and computes the diff.
 *
 * Returns ProjectChanges with empty arrays and comparedRunIds: null if fewer
 * than 2 completed runs are available for the project.
 */
export async function computeProjectChanges(db: Db, projectPath: string): Promise<ProjectChanges> {
  const empty: ProjectChanges = {
    projectPath,
    comparedRunIds: null,
    newlyBroken: [],
    newlyRecovered: [],
    stillFailing: [],
  };

  // Fetch the latest 2 completed runs for this project.
  // We exclude 'in-progress' runs — they may not have results yet.
  let runs: RunRow[];
  try {
    runs = db
      .prepare<RunRow>(
        `SELECT id, project_path, started_at, status
         FROM runs
         WHERE project_path = ? AND status != 'in-progress'
         ORDER BY started_at DESC
         LIMIT 2`,
      )
      .all(projectPath);
  } catch {
    return empty;
  }

  if (runs.length < 2) {
    return empty;
  }

  const [currentRun, previousRun] = runs;

  // Load test results for each run.
  // Current run: prefer the in-project .tspr/test_results.json (most up-to-date);
  // fall back to the archived path if missing.
  const currentPath = currentRunResultsPath(projectPath);
  const currentResultsRaw = fs.existsSync(currentPath)
    ? loadTestResults(currentPath)
    : loadTestResults(archivedRunResultsPath(currentRun.id));

  const previousResultsRaw = loadTestResults(archivedRunResultsPath(previousRun.id));

  const currentMap = buildResultMap(currentResultsRaw);
  const previousMap = buildResultMap(previousResultsRaw);

  // All testIds across both runs
  const allTestIds = new Set<string>([...currentMap.keys(), ...previousMap.keys()]);

  const newlyBroken: ProjectChanges['newlyBroken'] = [];
  const newlyRecovered: ProjectChanges['newlyRecovered'] = [];
  const stillFailing: ProjectChanges['stillFailing'] = [];

  for (const testId of allTestIds) {
    const cur = currentMap.get(testId);
    const prev = previousMap.get(testId);

    const curFailed = cur?.status === 'failed';
    const prevFailed = prev?.status === 'failed';
    const title = cur?.testName ?? prev?.testName ?? testId;
    const scenarioId = computeStableIssueId(testId, projectPath);

    if (curFailed && !prevFailed) {
      // Was passing (or absent) before, now failing
      newlyBroken.push({ scenarioId, title, runId: currentRun.id });
    } else if (!curFailed && prevFailed) {
      // Was failing before, now passing
      newlyRecovered.push({ scenarioId, title, runId: currentRun.id });
    } else if (curFailed && prevFailed) {
      // Failing in both — count consecutive runs in DB (up to the limit we queried)
      // We only queried 2, so the minimum consecutive count here is 2.
      stillFailing.push({ scenarioId, title, runsCount: 2 });
    }
    // If both passing: not interesting for change reporting
  }

  return {
    projectPath,
    comparedRunIds: { current: currentRun.id, previous: previousRun.id },
    newlyBroken,
    newlyRecovered,
    stillFailing,
  };
}
