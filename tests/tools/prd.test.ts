/**
 * Tests for Tool 3: tspr_generate_standardized_prd
 * Covers: B-3-1 through B-3-5, B-A-2, B-V-0
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { prdTool } from '../../src/tools/prd.js';
import {
  createTestProject,
  makeContext,
  makeMockCcClient,
  getMcpErrorData,
  type TestProject,
} from '../mcp/helpers.js';

const VALID_CODE_SUMMARY = JSON.stringify({
  framework: 'express',
  entryPoints: ['src/index.ts'],
  featureAreas: [],
  dependencies: [],
  testingSetup: 'vitest',
});

const VALID_PRD_RESPONSE = JSON.stringify({
  productOverview: 'A test project',
  userStories: [
    { id: 'US-1', title: 'Login', description: 'User can log in', priority: 'high' },
    { id: 'US-2', title: 'Dashboard', description: 'View dashboard', priority: 'medium' },
  ],
  functionalRequirements: ['Auth', 'Data display'],
  technicalRequirements: ['Node.js 24', 'TypeScript'],
});

describe('tspr_generate_standardized_prd', () => {
  const projects: TestProject[] = [];

  afterEach(() => {
    for (const p of projects.splice(0)) p.cleanup();
  });

  function mkProject(opts?: Parameters<typeof createTestProject>[0]): TestProject {
    const p = createTestProject(opts);
    projects.push(p);
    return p;
  }

  function mkProjectWithCodeSummary(): TestProject {
    const p = mkProject();
    const tsprDir = path.join(p.projectPath, '.tspr');
    fs.mkdirSync(tsprDir, { recursive: true });
    fs.writeFileSync(path.join(tsprDir, 'code_summary.json'), VALID_CODE_SUMMARY, 'utf-8');
    return p;
  }

  // ─── B-3-1: non-existent projectPath ──────────────────────────────────────
  it('PRD-001: non-existent projectPath returns ERR_PROJECT_NOT_FOUND', async () => {
    const ctx = makeContext();
    try {
      await prdTool.handler({ projectPath: '/nonexistent/abc123' }, ctx);
      expect.fail('Should have thrown');
    } catch (err) {
      const data = getMcpErrorData(err);
      expect(data?.code).toBe('ERR_PROJECT_NOT_FOUND');
      expect(data?.suggestion).toBeTruthy();
    }
  });

  // ─── B-3-2/B-A-2: success returns ok + outputPath ─────────────────────────
  it('PRD-002/ARTIFACT-002 (mock): success returns ok + outputPath to standard_prd.json', async () => {
    const p = mkProjectWithCodeSummary();
    const ctx = makeContext({ ccClient: makeMockCcClient(VALID_PRD_RESPONSE) });
    const result = await prdTool.handler({ projectPath: p.projectPath }, ctx);
    const parsed = JSON.parse(result.content[0].text) as {
      status: string;
      outputPath: string;
    };
    expect(parsed.status).toBe('ok');
    expect(parsed.outputPath).toMatch(/standard_prd\.json$/);
    expect(fs.existsSync(parsed.outputPath)).toBe(true);
    // File is valid JSON
    const content = fs.readFileSync(parsed.outputPath, 'utf-8');
    expect(() => JSON.parse(content)).not.toThrow();
  });

  // ─── B-3-3: userStories is an array ───────────────────────────────────────
  it('PRD-003 (mock): userStories is an array', async () => {
    const p = mkProjectWithCodeSummary();
    const ctx = makeContext({ ccClient: makeMockCcClient(VALID_PRD_RESPONSE) });
    const result = await prdTool.handler({ projectPath: p.projectPath }, ctx);
    const parsed = JSON.parse(result.content[0].text) as { userStories: unknown };
    expect(Array.isArray(parsed.userStories)).toBe(true);
  });

  // ─── B-3-4: each userStory has required fields ─────────────────────────────
  it('PRD-004 (mock): each userStory has id, title, description, valid priority', async () => {
    const p = mkProjectWithCodeSummary();
    const ctx = makeContext({ ccClient: makeMockCcClient(VALID_PRD_RESPONSE) });
    const result = await prdTool.handler({ projectPath: p.projectPath }, ctx);
    const parsed = JSON.parse(result.content[0].text) as {
      userStories: Array<{ id: string; title: string; description: string; priority: string }>;
    };
    for (const story of parsed.userStories) {
      expect(typeof story.id).toBe('string');
      expect(typeof story.title).toBe('string');
      expect(typeof story.description).toBe('string');
      expect(['high', 'medium', 'low']).toContain(story.priority);
    }
  });

  // ─── B-3-5: auto-generates code_summary if missing ────────────────────────
  it('PRD-005 (mock): project with no code_summary.json still succeeds', async () => {
    const p = mkProject();
    // cc client returns summary JSON for first call, then PRD JSON for second call
    let callCount = 0;
    const ctx = makeContext({
      ccClient: {
        async run(_opts) {
          callCount++;
          if (callCount === 1) {
            return { stdout: VALID_CODE_SUMMARY, costUsd: 0 };
          }
          return { stdout: VALID_PRD_RESPONSE, costUsd: 0 };
        },
      },
    });
    const result = await prdTool.handler({ projectPath: p.projectPath }, ctx);
    const parsed = JSON.parse(result.content[0].text) as { status: string };
    expect(parsed.status).toBe('ok');
  });

  // ─── B-V-0: missing required projectPath returns invalid ──────────────────
  it('VALIDATE-005: missing required projectPath schema rejection', () => {
    const { z } = require('zod');
    // The prd handler's inputSchema is prdInputSchema
    // We test via the tool's inputSchema directly
    const result = prdTool.inputSchema.safeParse({
      // projectPath missing
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path[0]);
      expect(paths).toContain('projectPath');
    }
  });

  // ─── Not-Node project ─────────────────────────────────────────────────────
  it('PRD: path without package.json returns ERR_NOT_NODE_PROJECT', async () => {
    const p = mkProject({ noPackageJson: true });
    const ctx = makeContext();
    try {
      await prdTool.handler({ projectPath: p.projectPath }, ctx);
      expect.fail('Should have thrown');
    } catch (err) {
      const data = getMcpErrorData(err);
      expect(data?.code).toBe('ERR_NOT_NODE_PROJECT');
    }
  });
});
