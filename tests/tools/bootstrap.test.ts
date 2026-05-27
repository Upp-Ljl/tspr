/**
 * Tests for Tool 1: tspr_bootstrap_tests
 * Covers: B-1-1 through B-1-10, B-V-1, B-V-2, B-E-1, B-E-2, B-E-3, B-E-5, B-E-6,
 *         B-4-8 sessions persistence (bootstrap inserts row so downstream tools find it)
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { bootstrapTool, bootstrapInputSchema } from '../../src/tools/bootstrap.js';
import {
  createTestProject,
  makeContext,
  makeMockDb,
  makeMockDockerManager,
  getMcpErrorData,
  getMcpErrorCode,
  type TestProject,
} from '../mcp/helpers.js';

describe('tspr_bootstrap_tests', () => {
  const projects: TestProject[] = [];

  afterEach(() => {
    for (const p of projects.splice(0)) p.cleanup();
  });

  function mkProject(opts?: Parameters<typeof createTestProject>[0]): TestProject {
    const p = createTestProject(opts);
    projects.push(p);
    return p;
  }

  // ─── B-1-1: non-existent projectPath ───────────────────────────────────────
  it('BOOTSTRAP-001: non-existent projectPath returns ERR_PROJECT_NOT_FOUND', async () => {
    const ctx = makeContext();
    const args = {
      projectPath: `/nonexistent/path/${crypto.randomUUID()}`,
      type: 'frontend' as const,
      testScope: 'codebase' as const,
    };
    await expect(bootstrapTool.handler(args, ctx)).rejects.toThrow(McpError);
    try {
      await bootstrapTool.handler(args, ctx);
    } catch (err) {
      const data = getMcpErrorData(err);
      expect(data?.code).toBe('ERR_PROJECT_NOT_FOUND');
      expect(data?.suggestion).toBeTruthy();
      // B-E-2: data.code matches the ERR_* portion of the message
      expect((err as McpError).message).toContain('ERR_PROJECT_NOT_FOUND');
      // B-E-5: runtime error = -32603
      expect(getMcpErrorCode(err)).toBe(ErrorCode.InternalError);
    }
  });

  // ─── B-1-2: path without package.json ──────────────────────────────────────
  it('BOOTSTRAP-002: path without package.json returns ERR_NOT_NODE_PROJECT', async () => {
    const p = mkProject({ noPackageJson: true });
    const ctx = makeContext();
    const args = {
      projectPath: p.projectPath,
      type: 'backend' as const,
      testScope: 'codebase' as const,
    };
    try {
      await bootstrapTool.handler(args, ctx);
      expect.fail('Should have thrown');
    } catch (err) {
      const data = getMcpErrorData(err);
      expect(data?.code).toBe('ERR_NOT_NODE_PROJECT');
      expect(data?.suggestion).toBeTruthy();
    }
  });

  // ─── B-1-8: Docker unavailable ─────────────────────────────────────────────
  it('BOOTSTRAP-008: Docker unavailable returns ERR_DOCKER_UNAVAILABLE', async () => {
    const p = mkProject();
    const ctx = makeContext({ docker: makeMockDockerManager(true) });
    const args = {
      projectPath: p.projectPath,
      type: 'frontend' as const,
      testScope: 'codebase' as const,
    };
    try {
      await bootstrapTool.handler(args, ctx);
      expect.fail('Should have thrown');
    } catch (err) {
      const data = getMcpErrorData(err);
      expect(data?.code).toBe('ERR_DOCKER_UNAVAILABLE');
      expect(data?.suggestion).toBeTruthy();
    }
  });

  // ─── B-1-5/B-E-6: localPort = 0 returns ERR_INVALID_PORT with -32602 ──────
  it('BOOTSTRAP-005: localPort=0 returns ERR_INVALID_PORT (zod schema)', () => {
    const result = bootstrapInputSchema.safeParse({
      localPort: 0,
      type: 'frontend',
      testScope: 'codebase',
      projectPath: '/tmp/test',
    });
    expect(result.success).toBe(false);
    // Port 0 is rejected by zod (min 1); dispatch throws InvalidParams (-32602)
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/ERR_INVALID_PORT|too_small|Number must be greater/i);
    }
  });

  // ─── B-1-6: localPort = 65536 ──────────────────────────────────────────────
  it('BOOTSTRAP-006: localPort=65536 returns invalid (zod schema)', () => {
    const result = bootstrapInputSchema.safeParse({
      localPort: 65536,
      type: 'frontend',
      testScope: 'codebase',
      projectPath: '/tmp/test',
    });
    expect(result.success).toBe(false);
  });

  // ─── B-1-7: localPort = 65535 is valid ────────────────────────────────────
  it('BOOTSTRAP-007: localPort=65535 is accepted by schema', () => {
    const result = bootstrapInputSchema.safeParse({
      localPort: 65535,
      type: 'frontend',
      testScope: 'codebase',
      projectPath: '/tmp/test',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.localPort).toBe(65535);
    }
  });

  // ─── B-1-9: missing required `type` returns -32602 ────────────────────────
  it('BOOTSTRAP-009: missing required type param rejected by schema (B-V-0)', () => {
    const result = bootstrapInputSchema.safeParse({
      projectPath: '/tmp/test',
      testScope: 'codebase',
      // type is missing
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path[0]);
      expect(paths).toContain('type');
    }
  });

  // ─── B-V-2: invalid enum for type ─────────────────────────────────────────
  it('VALIDATE-002: invalid enum for type returns invalid (B-V-2)', () => {
    const result = bootstrapInputSchema.safeParse({
      projectPath: '/tmp/test',
      type: 'fullstack', // invalid
      testScope: 'codebase',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const typePath = result.error.issues.find((i) => i.path[0] === 'type');
      expect(typePath).toBeTruthy();
    }
  });

  // ─── B-1-3 (mock Docker): success returns ok with sessionId ───────────────
  it('BOOTSTRAP-003 (mock): valid project + docker-mock returns ok with sessionId', async () => {
    const p = mkProject();
    const ctx = makeContext();
    const args = {
      projectPath: p.projectPath,
      type: 'frontend' as const,
      testScope: 'codebase' as const,
      localPort: 5173,
    };
    const result = await bootstrapTool.handler(args, ctx);
    expect(result.content[0].type).toBe('text');
    const parsed = JSON.parse(result.content[0].text) as {
      status: string;
      sessionId: string;
      projectType: string;
      detectedFramework: string;
      nextAction: string;
      warnings: string[];
    };
    expect(parsed.status).toBe('ok');
    expect(parsed.sessionId).toBeTruthy();
    expect(parsed.sessionId.length).toBeGreaterThan(0);
    expect(['frontend', 'backend', 'fullstack']).toContain(parsed.projectType);
    expect(parsed.detectedFramework).toBeTruthy();
    expect(parsed.nextAction).toBeTruthy();
    expect(Array.isArray(parsed.warnings)).toBe(true);
  });

  // ─── B-1-4: successive calls return distinct sessionIds ───────────────────
  it('BOOTSTRAP-004 (mock): successive calls return distinct sessionIds', async () => {
    const p = mkProject();
    const ctx = makeContext();
    const args = {
      projectPath: p.projectPath,
      type: 'frontend' as const,
      testScope: 'codebase' as const,
    };
    const r1 = await bootstrapTool.handler(args, ctx);
    const r2 = await bootstrapTool.handler(args, ctx);
    const s1 = JSON.parse(r1.content[0].text) as { sessionId: string };
    const s2 = JSON.parse(r2.content[0].text) as { sessionId: string };
    expect(s1.sessionId).not.toBe(s2.sessionId);
  });

  // ─── B-1-10: type=frontend returns non-empty detectedFramework ────────────
  it('BOOTSTRAP-010 (mock): type=frontend returns non-empty detectedFramework', async () => {
    const p = mkProject({
      packageJson: { name: 'test', version: '1.0.0', dependencies: { react: '^18.0.0' } },
    });
    const ctx = makeContext();
    const args = {
      projectPath: p.projectPath,
      type: 'frontend' as const,
      testScope: 'codebase' as const,
    };
    const result = await bootstrapTool.handler(args, ctx);
    const parsed = JSON.parse(result.content[0].text) as { detectedFramework: string };
    expect(parsed.detectedFramework).toBeTruthy();
    expect(parsed.detectedFramework.length).toBeGreaterThan(0);
  });

  // ─── B-V-1: string for localPort rejected ─────────────────────────────────
  it('VALIDATE-001: string for localPort rejected by schema (B-V-1)', () => {
    const result = bootstrapInputSchema.safeParse({
      localPort: '5173', // string not int
      type: 'frontend',
      testScope: 'codebase',
      projectPath: '/tmp/test',
    });
    expect(result.success).toBe(false);
  });

  // ─── B-E-1: error has non-empty suggestion ─────────────────────────────────
  it('ERROR-001: ERR_PROJECT_NOT_FOUND has non-empty data.suggestion', async () => {
    const ctx = makeContext();
    try {
      await bootstrapTool.handler({
        projectPath: '/nonexistent/abc',
        type: 'frontend',
        testScope: 'codebase',
      }, ctx);
    } catch (err) {
      const data = getMcpErrorData(err);
      expect(data?.suggestion).toBeTruthy();
      expect(data!.suggestion.length).toBeGreaterThan(0);
    }
  });

  // ─── B-E-2: data.code is contained in message ─────────────────────────────
  it('ERROR-002: data.code is contained in error.message (SDK prefixes "MCP error -NNNNN: ")', async () => {
    const ctx = makeContext();
    try {
      await bootstrapTool.handler({
        projectPath: '/nonexistent/abc',
        type: 'frontend',
        testScope: 'codebase',
      }, ctx);
    } catch (err) {
      if (err instanceof McpError) {
        const data = err.data as { code: string };
        // The MCP SDK wraps the message as "MCP error {code}: {message}"
        // The RPC-level error.message field is the second arg to McpError (the ERR_* string)
        expect(err.message).toContain(data.code);
      }
    }
  });

  // ─── B-4-8: sessions row persisted after successful bootstrap ─────────────
  it('BOOTSTRAP-011 (B-4-8): after bootstrap, sessions table has exactly 1 row matching returned sessionId', async () => {
    const p = mkProject();
    const db = makeMockDb();
    const ctx = makeContext({ db });
    const args = {
      projectPath: p.projectPath,
      type: 'frontend' as const,
      testScope: 'codebase' as const,
      localPort: 5173,
    };
    const result = await bootstrapTool.handler(args, ctx);
    const parsed = JSON.parse(result.content[0].text) as { sessionId: string };

    const sessionRows = db.getRows('sessions');
    // Assertion 1: exactly one session row was written
    expect(sessionRows).toHaveLength(1);
    // Assertion 2: the row's id matches the sessionId returned to the caller
    expect(sessionRows[0]['id']).toBe(parsed.sessionId);
  });

  // ─── B-4-8: sessions row has correct projectPath and localPort ────────────
  it('BOOTSTRAP-012 (B-4-8): sessions row stores project_path and local_port correctly', async () => {
    const p = mkProject();
    const db = makeMockDb();
    const ctx = makeContext({ db });
    const args = {
      projectPath: p.projectPath,
      type: 'backend' as const,
      testScope: 'diff' as const,
      localPort: 3000,
    };
    await bootstrapTool.handler(args, ctx);

    const sessionRows = db.getRows('sessions');
    // Assertion 3: project_path stored correctly
    expect(sessionRows[0]['project_path']).toBe(p.projectPath);
    // Assertion 4: local_port stored correctly
    expect(sessionRows[0]['local_port']).toBe(3000);
  });
});
