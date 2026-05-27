/**
 * Tests for Tool 2: tspr_generate_code_summary
 * Covers: B-2-1 through B-2-6, B-A-1
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { codeSummaryTool } from '../../src/tools/codeSummary.js';
import {
  createTestProject,
  makeContext,
  makeMockCcClient,
  makeFailingCcClient,
  getMcpErrorData,
  type TestProject,
} from '../mcp/helpers.js';

const VALID_SUMMARY_RESPONSE = JSON.stringify({
  framework: 'react',
  entryPoints: ['src/index.tsx'],
  featureAreas: [{ name: 'auth', files: ['src/auth.ts'] }],
  dependencies: [{ name: 'react', version: '^18.0.0' }],
  testingSetup: 'vitest',
});

describe('tspr_generate_code_summary', () => {
  const projects: TestProject[] = [];

  afterEach(() => {
    for (const p of projects.splice(0)) p.cleanup();
  });

  function mkProject(opts?: Parameters<typeof createTestProject>[0]): TestProject {
    const p = createTestProject(opts);
    projects.push(p);
    return p;
  }

  // ─── B-2-1: non-existent projectRootPath ──────────────────────────────────
  it('SUMMARY-001: non-existent projectRootPath returns ERR_PROJECT_NOT_FOUND', async () => {
    const ctx = makeContext();
    try {
      await codeSummaryTool.handler({ projectRootPath: '/nonexistent/abc123' }, ctx);
      expect.fail('Should have thrown');
    } catch (err) {
      const data = getMcpErrorData(err);
      expect(data?.code).toBe('ERR_PROJECT_NOT_FOUND');
      expect(data?.suggestion).toBeTruthy();
    }
  });

  // ─── B-2-2: no package.json ────────────────────────────────────────────────
  it('SUMMARY-002: path without package.json returns ERR_NOT_NODE_PROJECT', async () => {
    const p = mkProject({ noPackageJson: true });
    const ctx = makeContext();
    try {
      await codeSummaryTool.handler({ projectRootPath: p.projectPath }, ctx);
      expect.fail('Should have thrown');
    } catch (err) {
      const data = getMcpErrorData(err);
      expect(data?.code).toBe('ERR_NOT_NODE_PROJECT');
    }
  });

  // ─── B-2-3/B-A-1: success returns ok + outputPath ─────────────────────────
  it('SUMMARY-003/004 (mock): success returns ok + outputPath to code_summary.json', async () => {
    const p = mkProject();
    const ctx = makeContext({ llmClient: makeMockCcClient(VALID_SUMMARY_RESPONSE) });
    const result = await codeSummaryTool.handler({ projectRootPath: p.projectPath }, ctx);
    const parsed = JSON.parse(result.content[0].text) as {
      status: string;
      outputPath: string;
      framework: string;
      entryPoints: unknown[];
    };
    expect(parsed.status).toBe('ok');
    expect(parsed.outputPath).toMatch(/code_summary\.json$/);
    expect(fs.existsSync(parsed.outputPath)).toBe(true);
    // B-A-1: file is valid JSON
    const fileContent = fs.readFileSync(parsed.outputPath, 'utf-8');
    expect(() => JSON.parse(fileContent)).not.toThrow();
  });

  // ─── B-2-5: framework is non-empty string ─────────────────────────────────
  it('SUMMARY-005 (mock): framework is non-empty string', async () => {
    const p = mkProject();
    const ctx = makeContext({ llmClient: makeMockCcClient(VALID_SUMMARY_RESPONSE) });
    const result = await codeSummaryTool.handler({ projectRootPath: p.projectPath }, ctx);
    const parsed = JSON.parse(result.content[0].text) as { framework: string };
    expect(typeof parsed.framework).toBe('string');
    expect(parsed.framework.length).toBeGreaterThan(0);
  });

  // ─── B-2-6: entryPoints is an array ───────────────────────────────────────
  it('SUMMARY-006 (mock): entryPoints is an array', async () => {
    const p = mkProject();
    const ctx = makeContext({ llmClient: makeMockCcClient(VALID_SUMMARY_RESPONSE) });
    const result = await codeSummaryTool.handler({ projectRootPath: p.projectPath }, ctx);
    const parsed = JSON.parse(result.content[0].text) as { entryPoints: unknown };
    expect(Array.isArray(parsed.entryPoints)).toBe(true);
  });

  // ─── CC fail fallback (retry) ──────────────────────────────────────────────
  it('cc failure returns ERR_CC_FAILED', async () => {
    const p = mkProject();
    const ctx = makeContext({ llmClient: makeFailingCcClient() });
    try {
      await codeSummaryTool.handler({ projectRootPath: p.projectPath }, ctx);
      expect.fail('Should have thrown');
    } catch (err) {
      const data = getMcpErrorData(err);
      expect(data?.code).toBe('ERR_CC_FAILED');
    }
  });

  // ─── CC invalid JSON (after retry) ────────────────────────────────────────
  it('cc invalid JSON output returns ERR_CC_OUTPUT_INVALID', async () => {
    const p = mkProject();
    const ctx = makeContext({ llmClient: makeMockCcClient('not valid json at all!!!') });
    try {
      await codeSummaryTool.handler({ projectRootPath: p.projectPath }, ctx);
      expect.fail('Should have thrown');
    } catch (err) {
      const data = getMcpErrorData(err);
      expect(data?.code).toBe('ERR_CC_OUTPUT_INVALID');
    }
  });

  // ─── markdown-fenced JSON is parsed correctly ──────────────────────────────
  it('cc response with markdown fences is parsed correctly', async () => {
    const fencedResponse = `\`\`\`json\n${VALID_SUMMARY_RESPONSE}\n\`\`\``;
    const p = mkProject();
    const ctx = makeContext({ llmClient: makeMockCcClient(fencedResponse) });
    const result = await codeSummaryTool.handler({ projectRootPath: p.projectPath }, ctx);
    const parsed = JSON.parse(result.content[0].text) as { status: string; framework: string };
    expect(parsed.status).toBe('ok');
    expect(parsed.framework).toBe('react');
  });

  // ─── B-E-1/B-E-2: error structure ─────────────────────────────────────────
  it('ERROR-001/002: error has non-empty suggestion and code matches message', async () => {
    const ctx = makeContext();
    try {
      await codeSummaryTool.handler({ projectRootPath: '/nonexistent/abc' }, ctx);
    } catch (err) {
      if (err instanceof McpError) {
        const data = err.data as { code: string; suggestion: string };
        expect(data.suggestion.length).toBeGreaterThan(0);
        // SDK wraps message as "MCP error -NNNNN: {message}"; the RPC error.message = second arg = data.code
        expect(err.message).toContain(data.code);
      }
    }
  });
});
