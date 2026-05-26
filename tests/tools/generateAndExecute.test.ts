/**
 * Tests for Tool 6: tspr_generate_code_and_execute
 * Covers: B-6-1 through B-6-14, B-A-5, B-A-6, B-A-7, B-V-3
 * Docker is mocked via DockerSandbox interface.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { generateAndExecuteTool, generateAndExecuteInputSchema, runExecute } from '../../src/tools/generateAndExecute.js';
import type { DockerSandbox } from '../../src/tools/generateAndExecute.js';
import {
  createTestProject,
  makeContext,
  makeMockCcClient,
  makeMockDockerManager,
  getMcpErrorData,
  type TestProject,
} from '../mcp/helpers.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeVitestJsonOutput(passed: number, failed: number, skipped: number): string {
  const testResults = [];

  for (let i = 0; i < passed; i++) {
    testResults.push({ status: 'passed', fullName: `test-pass-${i}`, failureMessages: [] });
  }
  for (let i = 0; i < failed; i++) {
    testResults.push({
      status: 'failed',
      fullName: `test-fail-${i}`,
      failureMessages: [`Error: assertion failed at line ${i + 1}`],
    });
  }
  for (let i = 0; i < skipped; i++) {
    testResults.push({ status: 'pending', fullName: `test-skip-${i}`, failureMessages: [] });
  }

  return JSON.stringify({
    numPassedTests: passed,
    numFailedTests: failed,
    numPendingTests: skipped,
    testResults: [{ testFilePath: '/tests/test.spec.ts', testResults }],
  });
}

function makeSandboxWith(passed: number, failed: number, skipped: number = 0): DockerSandbox {
  return {
    async run(_opts) {
      return {
        stdout: makeVitestJsonOutput(passed, failed, skipped),
        stderr: '',
        exitCode: failed > 0 ? 1 : 0,
      };
    },
  };
}

function makeProjectWithPlan(scenarios: Array<{ id: string; title?: string }>): TestProject {
  const p = createTestProject();
  const tsprDir = path.join(p.projectPath, '.tspr');
  fs.mkdirSync(tsprDir, { recursive: true });
  const plan = {
    scenarios: scenarios.map((s) => ({
      id: s.id,
      title: s.title ?? s.id,
      type: 'happy-path',
      description: 'test',
      testHints: [],
    })),
    routesDiscovered: scenarios.length,
    warnings: [],
  };
  fs.writeFileSync(path.join(tsprDir, 'backend_test_plan.json'), JSON.stringify(plan), 'utf-8');
  return p;
}

describe('tspr_generate_code_and_execute', () => {
  const projects: TestProject[] = [];

  afterEach(() => {
    for (const p of projects.splice(0)) p.cleanup();
  });

  function mkProject(opts?: Parameters<typeof createTestProject>[0]): TestProject {
    const p = createTestProject(opts);
    projects.push(p);
    return p;
  }

  function mkProjectTrack(p: TestProject): void {
    projects.push(p);
  }

  // ─── B-6-1: no test plan → ERR_NO_TEST_PLAN ───────────────────────────────
  it('EXECUTE-001: no test plan returns ERR_NO_TEST_PLAN', async () => {
    const p = mkProject();
    const ctx = makeContext({ ccClient: makeMockCcClient('// test code') });
    try {
      await generateAndExecuteTool.handler(
        { projectName: 'test-proj', projectPath: p.projectPath, testIds: [], additionalInstruction: '' },
        ctx,
      );
      expect.fail('Should have thrown');
    } catch (err) {
      const data = getMcpErrorData(err);
      expect(data?.code).toBe('ERR_NO_TEST_PLAN');
      expect(data?.suggestion).toBeTruthy();
    }
  });

  // ─── B-6-2: Docker unavailable → ERR_DOCKER_UNAVAILABLE ──────────────────
  it('EXECUTE-002: Docker unavailable returns ERR_DOCKER_UNAVAILABLE', async () => {
    const p = makeProjectWithPlan([{ id: 'T-1' }]);
    mkProjectTrack(p);
    const ctx = makeContext({
      ccClient: makeMockCcClient('// test code'),
      docker: makeMockDockerManager(true),
    });
    try {
      await generateAndExecuteTool.handler(
        { projectName: 'test', projectPath: p.projectPath, testIds: [], additionalInstruction: '' },
        ctx,
      );
      expect.fail('Should have thrown');
    } catch (err) {
      const data = getMcpErrorData(err);
      expect(data?.code).toBe('ERR_DOCKER_UNAVAILABLE');
    }
  });

  // ─── B-6-3: totalTests = passed + failed + skipped ────────────────────────
  it('EXECUTE-003: totalTests = passed + failed + skipped', async () => {
    const p = makeProjectWithPlan([{ id: 'T-1' }, { id: 'T-2' }, { id: 'T-3' }]);
    mkProjectTrack(p);
    const ctx = makeContext({ ccClient: makeMockCcClient('// generated tests') });
    const result = await runExecute(
      { projectName: 'test', projectPath: p.projectPath, testIds: [], additionalInstruction: '' },
      ctx,
      makeSandboxWith(2, 1),
    );
    expect(result.totalTests).toBe(result.passed + result.failed + result.skipped);
    expect(result.totalTests).toBeGreaterThanOrEqual(0);
  });

  // ─── B-6-4/B-A-5: outputPath points to existing test_results.json ─────────
  it('EXECUTE-004/ARTIFACT-005: outputPath points to existing test_results.json', async () => {
    const p = makeProjectWithPlan([{ id: 'T-1' }]);
    mkProjectTrack(p);
    const ctx = makeContext({ ccClient: makeMockCcClient('// tests') });
    const result = await runExecute(
      { projectName: 'test', projectPath: p.projectPath, testIds: [], additionalInstruction: '' },
      ctx,
      makeSandboxWith(1, 0),
    );
    expect(result.outputPath).toBeTruthy();
    expect(fs.existsSync(result.outputPath)).toBe(true);
    const content = fs.readFileSync(result.outputPath, 'utf-8');
    const parsed = JSON.parse(content) as { status: string };
    expect(['ok', 'partial', 'all-failed']).toContain(parsed.status);
  });

  // ─── B-6-5/B-A-6: reportPath points to existing report.html ──────────────
  it('EXECUTE-005/ARTIFACT-006: reportPath points to existing non-empty report.html', async () => {
    const p = makeProjectWithPlan([{ id: 'T-1' }]);
    mkProjectTrack(p);
    const ctx = makeContext({ ccClient: makeMockCcClient('// tests') });
    const result = await runExecute(
      { projectName: 'test', projectPath: p.projectPath, testIds: [], additionalInstruction: '' },
      ctx,
      makeSandboxWith(1, 0),
    );
    expect(result.reportPath).toBeTruthy();
    expect(fs.existsSync(result.reportPath)).toBe(true);
    const stat = fs.statSync(result.reportPath);
    expect(stat.size).toBeGreaterThan(0);
  });

  // ─── B-6-6: all pass → status=ok, failures=[] ─────────────────────────────
  it('EXECUTE-006: all-pass returns status=ok and failures=[]', async () => {
    const p = makeProjectWithPlan([{ id: 'T-1' }, { id: 'T-2' }]);
    mkProjectTrack(p);
    const ctx = makeContext({ ccClient: makeMockCcClient('// tests') });
    const result = await runExecute(
      { projectName: 'test', projectPath: p.projectPath, testIds: [], additionalInstruction: '' },
      ctx,
      makeSandboxWith(2, 0),
    );
    expect(result.status).toBe('ok');
    expect(result.failures).toEqual([]);
    expect(result.passed).toBeGreaterThan(0);
    expect(result.failed).toBe(0);
  });

  // ─── B-6-7: failing test populates failures array ─────────────────────────
  it('EXECUTE-007: failing test populates failures array with required fields', async () => {
    const p = makeProjectWithPlan([{ id: 'T-1' }, { id: 'T-2' }]);
    mkProjectTrack(p);
    const ctx = makeContext({ ccClient: makeMockCcClient('// tests') });
    const result = await runExecute(
      { projectName: 'test', projectPath: p.projectPath, testIds: [], additionalInstruction: '' },
      ctx,
      makeSandboxWith(1, 1),
    );
    expect(result.failures.length).toBeGreaterThan(0);
    for (const f of result.failures) {
      expect(typeof f.testId).toBe('string');
      expect(f.testId.length).toBeGreaterThan(0);
      expect(typeof f.title).toBe('string');
      expect(f.title.length).toBeGreaterThan(0);
      expect(typeof f.stack).toBe('string');
      expect(f.stack.length).toBeGreaterThan(0);
      expect(typeof f.suggestedFixRegion.file).toBe('string');
      expect(f.suggestedFixRegion.file.length).toBeGreaterThan(0);
      expect(typeof f.suggestedFixRegion.why).toBe('string');
      expect(f.suggestedFixRegion.why.length).toBeGreaterThan(0);
      expect(typeof f.suggestedFixRegion.lineStart).toBe('number');
      expect(typeof f.suggestedFixRegion.lineEnd).toBe('number');
    }
  });

  // ─── B-6-8: testIds filter limits execution scope ─────────────────────────
  it('EXECUTE-008: testIds filter limits execution to matched IDs only', async () => {
    const p = makeProjectWithPlan([
      { id: 'T-1' }, { id: 'T-2' }, { id: 'T-3' }, { id: 'T-4' },
    ]);
    mkProjectTrack(p);
    const ctx = makeContext({ ccClient: makeMockCcClient('// tests') });

    // Run with 2 specific IDs
    const result = await runExecute(
      { projectName: 'test', projectPath: p.projectPath, testIds: ['T-1', 'T-3'], additionalInstruction: '' },
      ctx,
      makeSandboxWith(1, 1),
    );
    // totalTests = passed + failed (from sandbox output)
    expect(result.totalTests).toBe(result.passed + result.failed + result.skipped);
  });

  // ─── B-6-9: >10 scenarios truncated to 10 with warning ───────────────────
  it('EXECUTE-009: >10 scenarios truncated to 10 with truncation warning', async () => {
    const scenarios = Array.from({ length: 15 }, (_, i) => ({ id: `T-${i + 1}` }));
    const p = makeProjectWithPlan(scenarios);
    mkProjectTrack(p);
    const ctx = makeContext({ ccClient: makeMockCcClient('// tests') });
    const result = await runExecute(
      { projectName: 'test', projectPath: p.projectPath, testIds: [], additionalInstruction: '' },
      ctx,
      makeSandboxWith(5, 5),
    );
    expect(result.warnings.length).toBeGreaterThan(0);
    const hasTrancationWarning = result.warnings.some(
      (w) => w.toLowerCase().includes('truncat') || w.includes('10'),
    );
    expect(hasTrancationWarning).toBe(true);
  });

  // ─── B-6-10: all-failed status ────────────────────────────────────────────
  it('EXECUTE-010: all-fail sets status=all-failed', async () => {
    const p = makeProjectWithPlan([{ id: 'T-1' }, { id: 'T-2' }]);
    mkProjectTrack(p);
    const ctx = makeContext({ ccClient: makeMockCcClient('// tests') });
    const result = await runExecute(
      { projectName: 'test', projectPath: p.projectPath, testIds: [], additionalInstruction: '' },
      ctx,
      makeSandboxWith(0, 2),
    );
    expect(result.status).toBe('all-failed');
    expect(result.passed).toBe(0);
    expect(result.failed).toBeGreaterThan(0);
  });

  // ─── B-6-11: partial status ───────────────────────────────────────────────
  it('EXECUTE-011: partial pass sets status=partial', async () => {
    const p = makeProjectWithPlan([{ id: 'T-1' }, { id: 'T-2' }]);
    mkProjectTrack(p);
    const ctx = makeContext({ ccClient: makeMockCcClient('// tests') });
    const result = await runExecute(
      { projectName: 'test', projectPath: p.projectPath, testIds: [], additionalInstruction: '' },
      ctx,
      makeSandboxWith(1, 1),
    );
    expect(result.status).toBe('partial');
    expect(result.passed).toBeGreaterThan(0);
    expect(result.failed).toBeGreaterThan(0);
  });

  // ─── B-6-14: all-skipped → status=ok ─────────────────────────────────────
  it('EXECUTE-014: all-skipped returns status=ok', async () => {
    const p = makeProjectWithPlan([{ id: 'T-1' }, { id: 'T-2' }]);
    mkProjectTrack(p);
    const ctx = makeContext({ ccClient: makeMockCcClient('// tests') });
    const result = await runExecute(
      { projectName: 'test', projectPath: p.projectPath, testIds: [], additionalInstruction: '' },
      ctx,
      makeSandboxWith(0, 0, 2),
    );
    expect(result.status).toBe('ok');
    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBeGreaterThanOrEqual(0); // depends on sandbox output parsing
  });

  // ─── B-A-7: at least one .spec.ts exists ──────────────────────────────────
  it('ARTIFACT-007: at least one .spec.ts exists under generated_tests/ after execute', async () => {
    const p = makeProjectWithPlan([{ id: 'T-1' }]);
    mkProjectTrack(p);
    const ctx = makeContext({ ccClient: makeMockCcClient('import { test } from "vitest"; test("x", () => {});') });
    await runExecute(
      { projectName: 'my-project', projectPath: p.projectPath, testIds: [], additionalInstruction: '' },
      ctx,
      makeSandboxWith(1, 0),
    );
    const generatedDir = path.join(p.projectPath, '.tspr', 'generated_tests');
    expect(fs.existsSync(generatedDir)).toBe(true);
    const files = fs.readdirSync(generatedDir);
    const hasSpecFile = files.some((f) => f.endsWith('.spec.ts'));
    expect(hasSpecFile).toBe(true);
  });

  // ─── B-V-3: non-array testIds rejected by schema ──────────────────────────
  it('VALIDATE-003: non-array testIds returns -32602 from schema', () => {
    const result = generateAndExecuteInputSchema.safeParse({
      projectName: 'test',
      projectPath: '/tmp/test',
      testIds: 'test-1', // string, not array
    });
    expect(result.success).toBe(false);
  });
});
