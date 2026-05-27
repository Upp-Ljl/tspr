/**
 * Tests for Tool 5: tspr_generate_backend_test_plan
 * Covers: B-5-1 through B-5-6, B-A-4
 * New: BEPLAN-007/008/009 — Next.js App Router route scanning
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { backendPlanTool } from '../../src/tools/backendPlan.js';
import {
  createTestProject,
  makeContext,
  makeMockCcClient,
  getMcpErrorData,
  type TestProject,
} from '../mcp/helpers.js';

const VALID_BACKEND_PLAN = JSON.stringify({
  scenarios: [
    {
      id: 'BP-1',
      endpoint: 'GET /api/users',
      type: 'happy-path',
      description: 'List all users',
      testHints: ['Assert 200 status', 'Assert array response'],
    },
    {
      id: 'BP-2',
      endpoint: 'POST /api/users',
      type: 'error',
      description: 'Create user with invalid body',
      testHints: ['Assert 400 status'],
    },
    {
      id: 'BP-3',
      endpoint: 'GET /api/protected',
      type: 'auth',
      description: 'Access protected endpoint without auth',
      testHints: ['Assert 401 status'],
    },
  ],
});

describe('tspr_generate_backend_test_plan', () => {
  const projects: TestProject[] = [];

  afterEach(() => {
    for (const p of projects.splice(0)) p.cleanup();
  });

  function mkProject(opts?: Parameters<typeof createTestProject>[0]): TestProject {
    const p = createTestProject(opts);
    projects.push(p);
    return p;
  }

  function mkProjectWithRoutes(): TestProject {
    const p = mkProject({
      files: {
        'src/routes.ts': `
const router = express.Router();
router.get('/api/users', handler);
router.post('/api/users', handler);
router.get('/api/protected', authMiddleware, handler);
export default router;
`,
      },
    });
    return p;
  }

  // ─── B-5-1: non-existent projectPath ──────────────────────────────────────
  it('BEPLAN-001: non-existent projectPath returns ERR_PROJECT_NOT_FOUND', async () => {
    const ctx = makeContext();
    try {
      await backendPlanTool.handler({ projectPath: '/nonexistent/abc123' }, ctx);
      expect.fail('Should have thrown');
    } catch (err) {
      const data = getMcpErrorData(err);
      expect(data?.code).toBe('ERR_PROJECT_NOT_FOUND');
      expect(data?.suggestion).toBeTruthy();
    }
  });

  // ─── B-5-2/B-A-4: success returns ok + outputPath ─────────────────────────
  it('BEPLAN-002/ARTIFACT-004 (mock): success returns ok + outputPath to backend_test_plan.json', async () => {
    const p = mkProjectWithRoutes();
    const ctx = makeContext({ llmClient: makeMockCcClient(VALID_BACKEND_PLAN) });
    const result = await backendPlanTool.handler({ projectPath: p.projectPath }, ctx);
    const parsed = JSON.parse(result.content[0].text) as {
      status: string;
      outputPath: string;
    };
    expect(parsed.status).toBe('ok');
    expect(parsed.outputPath).toMatch(/backend_test_plan\.json$/);
    expect(fs.existsSync(parsed.outputPath)).toBe(true);
    // File is valid JSON
    const content = fs.readFileSync(parsed.outputPath, 'utf-8');
    expect(() => JSON.parse(content)).not.toThrow();
  });

  // ─── B-5-3: routesDiscovered is a non-negative integer ────────────────────
  it('BEPLAN-003 (mock): routesDiscovered is a non-negative integer', async () => {
    const p = mkProjectWithRoutes();
    const ctx = makeContext({ llmClient: makeMockCcClient(VALID_BACKEND_PLAN) });
    const result = await backendPlanTool.handler({ projectPath: p.projectPath }, ctx);
    const parsed = JSON.parse(result.content[0].text) as { routesDiscovered: number };
    expect(typeof parsed.routesDiscovered).toBe('number');
    expect(parsed.routesDiscovered).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(parsed.routesDiscovered)).toBe(true);
  });

  // ─── B-5-4: each scenario has required fields ──────────────────────────────
  it('BEPLAN-004 (mock): each scenario has id, endpoint, type, description, testHints', async () => {
    const p = mkProjectWithRoutes();
    const ctx = makeContext({ llmClient: makeMockCcClient(VALID_BACKEND_PLAN) });
    const result = await backendPlanTool.handler({ projectPath: p.projectPath }, ctx);
    const parsed = JSON.parse(result.content[0].text) as {
      scenarios: Array<{
        id: string;
        endpoint: string;
        type: string;
        description: string;
        testHints: string[];
      }>;
    };
    expect(parsed.scenarios.length).toBeGreaterThan(0);
    for (const s of parsed.scenarios) {
      expect(typeof s.id).toBe('string');
      expect(typeof s.endpoint).toBe('string');
      expect(s.endpoint.length).toBeGreaterThan(0);
      expect(typeof s.type).toBe('string');
      expect(typeof s.description).toBe('string');
      expect(Array.isArray(s.testHints)).toBe(true);
    }
  });

  // ─── B-5-5: scenario types are valid enums ────────────────────────────────
  it('BEPLAN-005 (mock): each scenario type is one of the 5 enum values', async () => {
    const p = mkProjectWithRoutes();
    const ctx = makeContext({ llmClient: makeMockCcClient(VALID_BACKEND_PLAN) });
    const result = await backendPlanTool.handler({ projectPath: p.projectPath }, ctx);
    const parsed = JSON.parse(result.content[0].text) as {
      scenarios: Array<{ type: string }>;
    };
    const validTypes = new Set(['happy-path', 'error', 'auth', 'integration', 'db']);
    for (const s of parsed.scenarios) {
      expect(validTypes.has(s.type), `Expected ${s.type} to be a valid scenario type`).toBe(true);
    }
  });

  // ─── B-5-6: no routes → ok + routesDiscovered=0 + warnings ──────────────
  it('BEPLAN-006: no-routes project returns ok with routesDiscovered=0 + warnings', async () => {
    const p = mkProject(); // just package.json, no route files
    const ctx = makeContext({ llmClient: makeMockCcClient('{}') });
    const result = await backendPlanTool.handler({ projectPath: p.projectPath }, ctx);
    const parsed = JSON.parse(result.content[0].text) as {
      status: string;
      routesDiscovered: number;
      scenarios: unknown[];
      warnings: string[];
    };
    expect(parsed.status).toBe('ok');
    expect(parsed.routesDiscovered).toBe(0);
    expect(Array.isArray(parsed.scenarios)).toBe(true);
    expect(Array.isArray(parsed.warnings)).toBe(true);
    expect(parsed.warnings.length).toBeGreaterThan(0);
    expect(parsed.warnings[0].length).toBeGreaterThan(0);
  });

  // ─── Not-Node project ─────────────────────────────────────────────────────
  it('BEPLAN: path without package.json returns ERR_NOT_NODE_PROJECT', async () => {
    const p = mkProject({ noPackageJson: true });
    const ctx = makeContext();
    try {
      await backendPlanTool.handler({ projectPath: p.projectPath }, ctx);
      expect.fail('Should have thrown');
    } catch (err) {
      const data = getMcpErrorData(err);
      expect(data?.code).toBe('ERR_NOT_NODE_PROJECT');
    }
  });

  // ─── BEPLAN-007: Next.js App Router (app/api/**) ──────────────────────────
  it('BEPLAN-007: Next.js App Router project with 3 routes detects all with correct methods', async () => {
    // Build a minimal Next.js project with app/api routes
    const p = mkProject({
      packageJson: { name: 'next-app', version: '1.0.0', dependencies: { next: '^15.0.0' } },
      files: {
        // Route 1: GET /api/users
        'app/api/users/route.ts': `
export async function GET(req: Request) {
  return Response.json([]);
}
`,
        // Route 2: GET + POST /api/posts
        'app/api/posts/route.ts': `
export async function GET() {
  return Response.json([]);
}
export async function POST(req: Request) {
  return Response.json({});
}
`,
        // Route 3: DELETE /api/posts/[id]  (dynamic param)
        'app/api/posts/[id]/route.ts': `
export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  return new Response(null, { status: 204 });
}
`,
      },
    });

    const ctx = makeContext({ llmClient: makeMockCcClient(VALID_BACKEND_PLAN) });
    const result = await backendPlanTool.handler({ projectPath: p.projectPath }, ctx);
    const parsed = JSON.parse(result.content[0].text) as {
      status: string;
      routesDiscovered: number;
    };

    expect(parsed.status).toBe('ok');
    // Expect: GET /api/users, GET /api/posts, POST /api/posts, DELETE /api/posts/:id  = 4 routes
    expect(parsed.routesDiscovered).toBe(4);

    // Verify the written file contains the expected endpoint strings
    const planPath = path.join(p.projectPath, '.tspr', 'backend_test_plan.json');
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf-8')) as { routesDiscovered: number };
    expect(plan.routesDiscovered).toBe(4);
  });

  // ─── BEPLAN-008: Next.js with src/ layout ────────────────────────────────
  it('BEPLAN-008: Next.js with src/app/api layout detects routes', async () => {
    const p = mkProject({
      packageJson: { name: 'next-src-app', version: '1.0.0', dependencies: { next: '^15.0.0' } },
      files: {
        // src/app/api structure
        'src/app/api/health/route.ts': `
export async function GET() {
  return Response.json({ ok: true });
}
`,
        'src/app/api/auth/login/route.ts': `
export async function POST(req: Request) {
  return Response.json({});
}
`,
      },
    });

    const ctx = makeContext({ llmClient: makeMockCcClient(VALID_BACKEND_PLAN) });
    const result = await backendPlanTool.handler({ projectPath: p.projectPath }, ctx);
    const parsed = JSON.parse(result.content[0].text) as {
      status: string;
      routesDiscovered: number;
    };

    expect(parsed.status).toBe('ok');
    // Expect: GET /api/health, POST /api/auth/login = 2 routes
    expect(parsed.routesDiscovered).toBe(2);
  });

  // ─── BEPLAN-009: Pages Router project unchanged ───────────────────────────
  it('BEPLAN-009: Next.js Pages Router (pages/api) project still detected correctly', async () => {
    // Pages Router: each file under pages/api is a route (gets GET + POST by default)
    const p = mkProject({
      packageJson: { name: 'next-pages', version: '1.0.0', dependencies: { next: '^14.0.0' } },
      files: {
        'pages/api/hello.ts': `
export default function handler(req, res) {
  res.json({ message: 'Hello' });
}
`,
        'pages/api/users/index.ts': `
export default function handler(req, res) {
  if (req.method === 'GET') res.json([]);
  else res.status(405).end();
}
`,
      },
    });

    const ctx = makeContext({ llmClient: makeMockCcClient(VALID_BACKEND_PLAN) });
    const result = await backendPlanTool.handler({ projectPath: p.projectPath }, ctx);
    const parsed = JSON.parse(result.content[0].text) as {
      status: string;
      routesDiscovered: number;
    };

    expect(parsed.status).toBe('ok');
    // Pages Router emits GET + POST for each file: 2 files × 2 = 4
    expect(parsed.routesDiscovered).toBeGreaterThanOrEqual(4);
  });
});
