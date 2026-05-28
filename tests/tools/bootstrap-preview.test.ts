/**
 * tests/tools/bootstrap-preview.test.ts
 *
 * Tests for the previewOnly flag added to tspr_bootstrap_tests.
 * Covers: returns preview shape without writing to SQLite, scenario loading,
 * cost estimation, backwards-compatibility (default previewOnly=false).
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { bootstrapTool, bootstrapInputSchema } from '../../src/tools/bootstrap.js';
import {
  createTestProject,
  makeContext,
  makeMockDb,
  type TestProject,
} from '../mcp/helpers.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mkProject(opts?: Parameters<typeof createTestProject>[0]): TestProject {
  return createTestProject(opts);
}

function writeTsprPlan(projectPath: string, filename: string, scenarios: unknown[]): void {
  const dir = path.join(projectPath, '.tspr');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, filename),
    JSON.stringify({ scenarios }, null, 2),
    'utf-8',
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('bootstrapTool — previewOnly', () => {
  const projects: TestProject[] = [];

  afterEach(() => {
    for (const p of projects.splice(0)) p.cleanup();
  });

  function track(p: TestProject): TestProject {
    projects.push(p);
    return p;
  }

  // ── PREVIEW-001: schema accepts previewOnly: true ─────────────────────────
  it('PREVIEW-001: schema accepts previewOnly: true', () => {
    const r = bootstrapInputSchema.safeParse({
      projectPath: '/tmp/test',
      type: 'frontend',
      testScope: 'codebase',
      previewOnly: true,
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.previewOnly).toBe(true);
  });

  // ── PREVIEW-002: previewOnly defaults to false ────────────────────────────
  it('PREVIEW-002: previewOnly defaults to false when omitted', () => {
    const r = bootstrapInputSchema.safeParse({
      projectPath: '/tmp/test',
      type: 'frontend',
      testScope: 'codebase',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.previewOnly).toBe(false);
  });

  // ── PREVIEW-003: previewOnly=true returns preview shape, no sessionId ─────
  it('PREVIEW-003: previewOnly=true returns {status:ok, preview:true} without sessionId', async () => {
    const p = track(mkProject());
    const db = makeMockDb();
    const ctx = makeContext({ db });

    const result = await bootstrapTool.handler({
      projectPath: p.projectPath,
      type: 'frontend',
      testScope: 'codebase',
      previewOnly: true,
    }, ctx);

    const parsed = JSON.parse(result.content[0].text) as Record<string, unknown>;
    expect(parsed.status).toBe('ok');
    expect(parsed.preview).toBe(true);
    expect(parsed.sessionId).toBeUndefined();
    expect(typeof parsed.projectType).toBe('string');
    expect(typeof parsed.detectedFramework).toBe('string');
    expect(Array.isArray(parsed.scenarios)).toBe(true);
    expect(typeof parsed.estimatedCostUsd).toBe('number');
    expect(typeof parsed.estimatedDurationS).toBe('number');
    expect(Array.isArray(parsed.warnings)).toBe(true);
  });

  // ── PREVIEW-004: previewOnly=true writes NO rows to SQLite ───────────────
  it('PREVIEW-004: previewOnly=true writes no rows to sessions or runs tables', async () => {
    const p = track(mkProject());
    const db = makeMockDb();
    const ctx = makeContext({ db });

    await bootstrapTool.handler({
      projectPath: p.projectPath,
      type: 'backend',
      testScope: 'codebase',
      previewOnly: true,
    }, ctx);

    expect(db.getRows('sessions')).toHaveLength(0);
    expect(db.getRows('runs')).toHaveLength(0);
  });

  // ── PREVIEW-005: previewOnly=true skips Docker check ─────────────────────
  it('PREVIEW-005: previewOnly=true does not throw even when Docker would fail', async () => {
    const p = track(mkProject());
    // Even with a docker mock that fails ping, previewOnly should not call docker
    const ctx = makeContext({
      docker: {
        async ping() { throw new Error('Docker not available'); },
        async createContainer() { throw new Error('no docker'); },
        async teardownAll() {},
      },
    });

    // Should NOT throw (Docker is not checked in preview mode)
    await expect(
      bootstrapTool.handler({
        projectPath: p.projectPath,
        type: 'frontend',
        testScope: 'codebase',
        previewOnly: true,
      }, ctx),
    ).resolves.toBeTruthy();
  });

  // ── PREVIEW-006: loads scenarios from existing .tspr plan files ──────────
  it('PREVIEW-006: loads scenarios from .tspr/backend_test_plan.json when present', async () => {
    const p = track(mkProject());
    writeTsprPlan(p.projectPath, 'backend_test_plan.json', [
      { id: 's1', title: 'Auth login', kind: 'backend-integration' },
      { id: 's2', title: 'Register user', kind: 'backend-integration' },
    ]);

    const ctx = makeContext();
    const result = await bootstrapTool.handler({
      projectPath: p.projectPath,
      type: 'backend',
      testScope: 'codebase',
      previewOnly: true,
    }, ctx);

    const parsed = JSON.parse(result.content[0].text) as { scenarios: Array<{ id: string; title: string }> };
    expect(parsed.scenarios).toHaveLength(2);
    expect(parsed.scenarios[0].id).toBe('s1');
    expect(parsed.scenarios[0].title).toBe('Auth login');
    expect(parsed.scenarios[1].id).toBe('s2');
  });

  // ── PREVIEW-007: cost estimation matches formula ──────────────────────────
  it('PREVIEW-007: estimatedCostUsd = scenarios.length * 0.005, estimatedDurationS = scenarios.length * 3', async () => {
    const p = track(mkProject());
    writeTsprPlan(p.projectPath, 'frontend_test_plan.json', [
      { id: 'f1', title: 'Home page renders', kind: 'frontend-e2e' },
      { id: 'f2', title: 'Login form submits', kind: 'frontend-e2e' },
      { id: 'f3', title: 'Dashboard loads', kind: 'frontend-e2e' },
      { id: 'f4', title: 'Settings page', kind: 'frontend-e2e' },
    ]);

    const ctx = makeContext();
    const result = await bootstrapTool.handler({
      projectPath: p.projectPath,
      type: 'frontend',
      testScope: 'codebase',
      previewOnly: true,
    }, ctx);

    const parsed = JSON.parse(result.content[0].text) as {
      estimatedCostUsd: number;
      estimatedDurationS: number;
      scenarios: unknown[];
    };
    expect(parsed.scenarios).toHaveLength(4);
    expect(parsed.estimatedCostUsd).toBeCloseTo(4 * 0.005, 6);
    expect(parsed.estimatedDurationS).toBe(12);
  });

  // ── PREVIEW-008: warns when no existing plans found ──────────────────────
  it('PREVIEW-008: returns warning when no .tspr plans exist', async () => {
    const p = track(mkProject());
    // No .tspr/ directory created
    const ctx = makeContext();
    const result = await bootstrapTool.handler({
      projectPath: p.projectPath,
      type: 'frontend',
      testScope: 'codebase',
      previewOnly: true,
    }, ctx);

    const parsed = JSON.parse(result.content[0].text) as { warnings: string[]; scenarios: unknown[] };
    expect(parsed.scenarios).toHaveLength(0);
    expect(parsed.warnings.length).toBeGreaterThan(0);
    expect(parsed.warnings[0]).toMatch(/No existing test plans/i);
  });

  // ── PREVIEW-009: previewOnly=false still writes sessions row (backwards-compat) ─
  it('PREVIEW-009 (backwards-compat): previewOnly=false writes session row as before', async () => {
    const p = track(mkProject());
    const db = makeMockDb();
    const ctx = makeContext({ db });

    await bootstrapTool.handler({
      projectPath: p.projectPath,
      type: 'frontend',
      testScope: 'codebase',
      previewOnly: false,
    }, ctx);

    expect(db.getRows('sessions')).toHaveLength(1);
    expect(db.getRows('runs')).toHaveLength(1);
  });

  // ── PREVIEW-010: loads scenarios from both frontend + backend plans ───────
  it('PREVIEW-010: merges scenarios from both frontend and backend test plans', async () => {
    const p = track(mkProject());
    writeTsprPlan(p.projectPath, 'backend_test_plan.json', [
      { id: 'b1', title: 'Backend auth', kind: 'backend-integration' },
    ]);
    writeTsprPlan(p.projectPath, 'frontend_test_plan.json', [
      { id: 'f1', title: 'Frontend home', kind: 'frontend-e2e' },
      { id: 'f2', title: 'Frontend login', kind: 'frontend-e2e' },
    ]);

    const ctx = makeContext();
    const result = await bootstrapTool.handler({
      projectPath: p.projectPath,
      type: 'frontend',
      testScope: 'codebase',
      previewOnly: true,
    }, ctx);

    const parsed = JSON.parse(result.content[0].text) as { scenarios: Array<{ id: string }> };
    expect(parsed.scenarios).toHaveLength(3);
    const ids = parsed.scenarios.map((s) => s.id);
    expect(ids).toContain('b1');
    expect(ids).toContain('f1');
    expect(ids).toContain('f2');
  });
});
