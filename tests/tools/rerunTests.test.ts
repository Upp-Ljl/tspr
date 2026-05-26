/**
 * Tests for Tool 8: tspr_rerun_tests
 * Covers: B-8-1 through B-8-6
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { rerunTestsTool } from '../../src/tools/rerunTests.js';
import {
  createTestProject,
  makeContext,
  makeMockCcClient,
  getMcpErrorData,
  type TestProject,
} from '../mcp/helpers.js';

describe('tspr_rerun_tests', () => {
  const projects: TestProject[] = [];

  afterEach(() => {
    for (const p of projects.splice(0)) p.cleanup();
  });

  function mkProject(opts?: Parameters<typeof createTestProject>[0]): TestProject {
    const p = createTestProject(opts);
    projects.push(p);
    return p;
  }

  function makeProjectWithPriorRun(): TestProject {
    const p = mkProject();
    const tsprDir = path.join(p.projectPath, '.tspr');
    const generatedTestsDir = path.join(tsprDir, 'generated_tests');
    fs.mkdirSync(generatedTestsDir, { recursive: true });

    // Create a fake test_results.json (simulating prior run)
    const fakeResults = {
      status: 'ok',
      outputPath: path.join(tsprDir, 'test_results.json'),
      reportPath: path.join(tsprDir, 'report.html'),
      totalTests: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      warnings: [],
      failures: [],
    };
    fs.writeFileSync(path.join(tsprDir, 'test_results.json'), JSON.stringify(fakeResults), 'utf-8');

    // Create fake .spec.ts file
    fs.writeFileSync(
      path.join(generatedTestsDir, 'test-project.spec.ts'),
      'import { test } from "vitest"; test("x", () => {});',
      'utf-8',
    );

    // Also write a backend plan so runExecute doesn't fail with ERR_NO_TEST_PLAN
    const plan = {
      scenarios: [{ id: 'T-1', title: 'Test 1', type: 'happy-path', description: 'test', testHints: [] }],
      routesDiscovered: 1,
      warnings: [],
    };
    fs.writeFileSync(path.join(tsprDir, 'backend_test_plan.json'), JSON.stringify(plan), 'utf-8');

    return p;
  }

  // ─── B-8-1: no prior run → ERR_NO_PRIOR_RUN ──────────────────────────────
  it('RERUN-001: no prior run returns ERR_NO_PRIOR_RUN', async () => {
    const p = mkProject();
    const ctx = makeContext();
    try {
      await rerunTestsTool.handler({ projectPath: p.projectPath }, ctx);
      expect.fail('Should have thrown');
    } catch (err) {
      const data = getMcpErrorData(err);
      expect(data?.code).toBe('ERR_NO_PRIOR_RUN');
      expect(data?.suggestion).toBeTruthy();
    }
  });

  // ─── B-8-2: deleted generated test files → ERR_GENERATED_TESTS_MISSING ────
  it('RERUN-002: deleted generated tests returns ERR_GENERATED_TESTS_MISSING', async () => {
    const p = mkProject();
    const tsprDir = path.join(p.projectPath, '.tspr');
    const generatedTestsDir = path.join(tsprDir, 'generated_tests');
    fs.mkdirSync(generatedTestsDir, { recursive: true });

    // Create test_results.json but NOT .spec.ts files
    const fakeResults = { status: 'ok', totalTests: 1 };
    fs.writeFileSync(path.join(tsprDir, 'test_results.json'), JSON.stringify(fakeResults), 'utf-8');

    const ctx = makeContext();
    try {
      await rerunTestsTool.handler({ projectPath: p.projectPath }, ctx);
      expect.fail('Should have thrown');
    } catch (err) {
      const data = getMcpErrorData(err);
      expect(data?.code).toBe('ERR_GENERATED_TESTS_MISSING');
      expect(data?.suggestion).toBeTruthy();
    }
  });

  // ─── B-8-5: non-existent projectPath → ERR_PROJECT_NOT_FOUND ─────────────
  it('RERUN-005: non-existent projectPath returns ERR_PROJECT_NOT_FOUND', async () => {
    const ctx = makeContext();
    try {
      await rerunTestsTool.handler({ projectPath: '/nonexistent/abc123' }, ctx);
      expect.fail('Should have thrown');
    } catch (err) {
      const data = getMcpErrorData(err);
      expect(data?.code).toBe('ERR_PROJECT_NOT_FOUND');
    }
  });

  // ─── B-8-3: success returns same shape as generate_code_and_execute ────────
  it('RERUN-003 (mock): success returns same response shape as generate_code_and_execute', async () => {
    const p = makeProjectWithPriorRun();
    const ctx = makeContext({ ccClient: makeMockCcClient('// tests') });

    const result = await rerunTestsTool.handler({ projectPath: p.projectPath }, ctx);
    const parsed = JSON.parse(result.content[0].text) as Record<string, unknown>;

    // Must have all required fields from the shared shape
    expect(typeof parsed.status).toBe('string');
    expect(['ok', 'partial', 'all-failed']).toContain(parsed.status);
    expect(typeof parsed.outputPath).toBe('string');
    expect(typeof parsed.reportPath).toBe('string');
    expect(typeof parsed.totalTests).toBe('number');
    expect(typeof parsed.passed).toBe('number');
    expect(typeof parsed.failed).toBe('number');
    expect(typeof parsed.skipped).toBe('number');
    expect(Array.isArray(parsed.warnings)).toBe(true);
    expect(Array.isArray(parsed.failures)).toBe(true);
  });

  // ─── B-8-4: test_results.json is updated ──────────────────────────────────
  it('RERUN-004 (mock): test_results.json is updated after rerun', async () => {
    const p = makeProjectWithPriorRun();
    const tsprDir = path.join(p.projectPath, '.tspr');
    const testResultsPath = path.join(tsprDir, 'test_results.json');

    // Get initial mtime
    const statBefore = fs.statSync(testResultsPath);
    const mtimeBefore = statBefore.mtimeMs;

    // Wait 1s to ensure mtime difference
    await new Promise((r) => setTimeout(r, 1100));

    const ctx = makeContext({ ccClient: makeMockCcClient('// tests') });
    await rerunTestsTool.handler({ projectPath: p.projectPath }, ctx);

    const statAfter = fs.statSync(testResultsPath);
    expect(statAfter.mtimeMs).toBeGreaterThan(mtimeBefore);
  });

  // ─── Input schema: projectPath is required ────────────────────────────────
  it('RERUN schema: missing projectPath rejected', () => {
    const result = rerunTestsTool.inputSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path[0]);
      expect(paths).toContain('projectPath');
    }
  });
});
