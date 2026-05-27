/**
 * Integration test: Tool 6 with real Docker sandbox.
 *
 * Skipped automatically when Docker is unavailable or the sandbox image is missing.
 * Uses a tiny fixture project (inline package.json + trivial spec) so the test
 * doesn't depend on any external project.
 *
 * Run: npm test -- tests/integration/tool6-real-sandbox.test.ts
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { runExecute } from '../../src/tools/generateAndExecute.js';
import {
  makeContext,
  makeMockCcClient,
} from '../mcp/helpers.js';

// ─── Docker availability guard ────────────────────────────────────────────────

let dockerAvailable = true;

beforeAll(() => {
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 5000 });
    execSync('docker image inspect tspr/sandbox-node:24', { stdio: 'pipe', timeout: 5000 });
  } catch {
    dockerAvailable = false;
    console.warn('[tool6-real-sandbox.test] Docker or sandbox image not available — skipping');
  }
});

// ─── Fixture factory ──────────────────────────────────────────────────────────

interface FixtureProject {
  projectPath: string;
  cleanup: () => void;
}

function makeFixtureProject(): FixtureProject {
  const tmpDir = path.join(os.tmpdir(), `tspr-integ-${crypto.randomUUID()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  // Minimal package.json — not used for npm install any more (runtime is pre-baked
  // in /tspr-runtime inside the image), but needed so projectPath looks like a project.
  fs.writeFileSync(
    path.join(tmpDir, 'package.json'),
    JSON.stringify({
      name: 'tspr-fixture',
      version: '1.0.0',
      private: true,
    }, null, 2),
    'utf-8',
  );

  // Trivial spec that always passes — no server, no supertest.
  // The new exec flow copies this into /tspr-runtime/tests inside the container.
  const tsprDir = path.join(tmpDir, '.tspr');
  const generatedTestsDir = path.join(tsprDir, 'generated_tests');
  fs.mkdirSync(generatedTestsDir, { recursive: true });

  fs.writeFileSync(
    path.join(generatedTestsDir, 'fixture.spec.ts'),
    `import { describe, it, expect } from 'vitest';
describe('fixture', () => {
  it('trivial passing test', () => {
    expect(1 + 1).toBe(2);
  });
});
`,
    'utf-8',
  );

  // Backend test plan so ERR_NO_TEST_PLAN is not thrown
  fs.writeFileSync(
    path.join(tsprDir, 'backend_test_plan.json'),
    JSON.stringify({
      scenarios: [{ id: 'FIXTURE-1', title: 'Trivial test', type: 'happy-path', description: 'Always passes' }],
      routesDiscovered: 1,
      warnings: [],
    }),
    'utf-8',
  );

  return {
    projectPath: tmpDir,
    cleanup: () => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe.skipIf(!dockerAvailable)('tool6 real sandbox integration', () => {
  const fixtures: FixtureProject[] = [];

  afterEach(() => {
    for (const f of fixtures.splice(0)) f.cleanup();
  });

  it('INTEG-001: runs generated tests inside real container and returns ExecuteResult', async () => {
    if (!dockerAvailable) return; // belt-and-suspenders for non-describe.skipIf envs

    const fixture = makeFixtureProject();
    fixtures.push(fixture);

    // The cc client returns empty string — the spec file is already written directly
    // to generatedTestsDir by makeFixtureProject, so the generated code path just
    // overwrites it. To avoid that, we mock cc to return the same trivial spec content.
    const trivialSpec = `import { describe, it, expect } from 'vitest';
describe('fixture', () => {
  it('trivial passing test', () => {
    expect(1 + 1).toBe(2);
  });
});
`;

    const ctx = makeContext({
      llmClient: makeMockCcClient(trivialSpec),
      // No docker injected — production path uses createSandbox directly
    });
    // Remove the default docker from ctx so the production branch is exercised
    delete ctx.docker;

    const result = await runExecute(
      {
        projectName: 'tspr-fixture',
        projectPath: fixture.projectPath,
        testIds: [],
        additionalInstruction: '',
      },
      ctx,
      // sandbox param intentionally omitted → production path
    );

    // The trivial spec must have at least 1 passing test
    expect(result).toBeDefined();
    expect(result.passed).toBeGreaterThanOrEqual(1);
    expect(result.failed).toBe(0);
    expect(result.status).toBe('ok');
    expect(result.outputPath).toBeTruthy();
    expect(fs.existsSync(result.outputPath)).toBe(true);
    expect(result.reportPath).toBeTruthy();
    expect(fs.existsSync(result.reportPath)).toBe(true);
  }, { timeout: 300_000 }); // npm install + vitest in container can take a while
});
