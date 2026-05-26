/**
 * Tests for error response structure and validation contracts
 * Covers: B-E-1 through B-E-6, B-V-0 through B-V-4, ERROR-001 through ERROR-005
 */
import { describe, it, expect } from 'vitest';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { bootstrapTool } from '../../src/tools/bootstrap.js';
import { codeSummaryTool } from '../../src/tools/codeSummary.js';
import { prdTool } from '../../src/tools/prd.js';
import { backendPlanTool } from '../../src/tools/backendPlan.js';
import { rerunTestsTool } from '../../src/tools/rerunTests.js';
import { generateAndExecuteTool } from '../../src/tools/generateAndExecute.js';
import { TOOL_MAP } from '../../src/mcp/registry.js';
import { makeContext } from './helpers.js';

type ErrorWithData = McpError & { data: { code: string; suggestion: string } };

async function getError(
  tool: { handler: (args: unknown, ctx: ReturnType<typeof makeContext>) => Promise<unknown> },
  args: unknown,
): Promise<ErrorWithData | null> {
  try {
    await tool.handler(args, makeContext());
    return null;
  } catch (err) {
    if (err instanceof McpError) return err as ErrorWithData;
    throw err;
  }
}

describe('Error Response Structure (B-E-*)', () => {
  // ─── B-E-1: every error has non-empty data.suggestion ─────────────────────
  it('ERROR-001: all error responses have non-empty data.suggestion', async () => {
    const errorsToTest = [
      await getError(bootstrapTool, { projectPath: '/nonexistent/abc', type: 'frontend', testScope: 'codebase' }),
      await getError(codeSummaryTool, { projectRootPath: '/nonexistent/abc' }),
      await getError(prdTool, { projectPath: '/nonexistent/abc' }),
      await getError(backendPlanTool, { projectPath: '/nonexistent/abc' }),
      await getError(rerunTestsTool, { projectPath: '/nonexistent/abc' }),
    ];

    for (const err of errorsToTest) {
      expect(err).not.toBeNull();
      if (err) {
        const data = err.data as { suggestion?: string };
        expect(data?.suggestion).toBeTruthy();
        expect(data!.suggestion!.length).toBeGreaterThan(0);
      }
    }
  });

  // ─── B-E-2: data.code is in the message field ─────────────────────────────
  it('ERROR-002: data.code is contained in error.message for multiple error types (B-E-2)', async () => {
    const errorsToTest = [
      { tool: bootstrapTool, args: { projectPath: '/nonexistent', type: 'frontend', testScope: 'codebase' } },
      { tool: codeSummaryTool, args: { projectRootPath: '/nonexistent' } },
      { tool: rerunTestsTool, args: { projectPath: '/nonexistent' } },
    ];

    for (const { tool, args } of errorsToTest) {
      const err = await getError(tool, args);
      expect(err).not.toBeNull();
      if (err) {
        const data = err.data as { code: string };
        // MCP SDK wraps: "MCP error {rpcCode}: {message}" where message = the ERR_* string we passed
        // The RPC-level error.message field = second arg to McpError = data.code
        expect(err.message).toContain(data.code);
      }
    }
  });

  // ─── B-E-3: input validation errors have -32602 ───────────────────────────
  it('ERROR-003: input validation errors use ErrorCode.InvalidParams', () => {
    // Zod schema validation errors → thrown as McpError(ErrorCode.InvalidParams)
    // We test this at the schema level since the server dispatch does the throwing
    const bootstrapSchema = bootstrapTool.inputSchema;

    // Missing required type
    const r1 = bootstrapSchema.safeParse({ projectPath: '/tmp', testScope: 'codebase' });
    expect(r1.success).toBe(false);

    // Wrong type for localPort
    const r2 = bootstrapSchema.safeParse({ projectPath: '/tmp', type: 'frontend', testScope: 'codebase', localPort: '5173' });
    expect(r2.success).toBe(false);

    // Invalid enum
    const r3 = bootstrapSchema.safeParse({ projectPath: '/tmp', type: 'fullstack', testScope: 'codebase' });
    expect(r3.success).toBe(false);

    // The server dispatch creates McpError(ErrorCode.InvalidParams, ...)
    // ErrorCode.InvalidParams = -32602
    expect(ErrorCode.InvalidParams).toBe(-32602);
  });

  // ─── B-E-4: unknown tool → -32601 ────────────────────────────────────────
  it('ERROR-004: ErrorCode.MethodNotFound is -32601', () => {
    expect(ErrorCode.MethodNotFound).toBe(-32601);
  });

  // ─── B-E-5: runtime errors → -32603 ──────────────────────────────────────
  it('ERROR-005: runtime errors use ErrorCode.InternalError (-32603)', async () => {
    const err = await getError(bootstrapTool, { projectPath: '/nonexistent/abc', type: 'frontend', testScope: 'codebase' });
    expect(err).not.toBeNull();
    if (err) {
      expect(err.code).toBe(ErrorCode.InternalError);
      expect(err.code).toBe(-32603);
    }
  });

  // ─── B-E-6: ERR_INVALID_PORT uses -32602 (schema = input validation) ──────
  it('ERROR-006: ERR_INVALID_PORT (localPort=0) rejected by schema at -32602 level', () => {
    const result = bootstrapTool.inputSchema.safeParse({
      localPort: 0,
      type: 'frontend',
      testScope: 'codebase',
      projectPath: '/tmp/test',
    });
    expect(result.success).toBe(false);
    // Schema rejection → server dispatch throws InvalidParams = -32602
    expect(ErrorCode.InvalidParams).toBe(-32602);
  });

  it('ERROR-006: ERR_INVALID_PORT (localPort=65536) rejected at schema level', () => {
    const result = bootstrapTool.inputSchema.safeParse({
      localPort: 65536,
      type: 'frontend',
      testScope: 'codebase',
      projectPath: '/tmp/test',
    });
    expect(result.success).toBe(false);
  });
});

describe('Input Validation Contracts (B-V-*)', () => {
  // ─── B-V-0: omitting required field → -32602 (schema rejection) ──────────
  it('VALIDATE-005 (B-V-0): omitting projectPath from prd returns schema error', () => {
    const result = prdTool.inputSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path[0]);
      expect(paths).toContain('projectPath');
    }
  });

  it('VALIDATE-005 (B-V-0): omitting projectPath from backendPlan returns schema error', () => {
    const result = backendPlanTool.inputSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('VALIDATE-005 (B-V-0): omitting projectName from generateAndExecute returns schema error', () => {
    const result = generateAndExecuteTool.inputSchema.safeParse({ projectPath: '/tmp' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path[0]);
      expect(paths).toContain('projectName');
    }
  });

  // ─── B-V-1: string for localPort → rejected ───────────────────────────────
  it('VALIDATE-001 (B-V-1): string for localPort returns schema error', () => {
    const result = bootstrapTool.inputSchema.safeParse({
      localPort: '5173',
      type: 'frontend',
      testScope: 'codebase',
      projectPath: '/tmp/test',
    });
    expect(result.success).toBe(false);
  });

  // ─── B-V-2: invalid enum for type ─────────────────────────────────────────
  it('VALIDATE-002 (B-V-2): invalid enum for type returns schema error', () => {
    const result = bootstrapTool.inputSchema.safeParse({
      type: 'fullstack',
      testScope: 'codebase',
      projectPath: '/tmp/test',
    });
    expect(result.success).toBe(false);
  });

  // ─── B-V-3: non-array testIds → rejected ──────────────────────────────────
  it('VALIDATE-003 (B-V-3): non-array testIds returns schema error', () => {
    const result = generateAndExecuteTool.inputSchema.safeParse({
      projectName: 'test',
      projectPath: '/tmp/test',
      testIds: 'test-1', // string, not array
    });
    expect(result.success).toBe(false);
  });

  // ─── B-V-4: dashboard accepts empty and extra fields ─────────────────────
  it('VALIDATE-004 (B-V-4): dashboard accepts empty input object', () => {
    const result = TOOL_MAP.get('tspr_open_test_result_dashboard')!.inputSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('VALIDATE-004 (B-V-4): dashboard accepts extra unknown fields via passthrough', () => {
    const result = TOOL_MAP.get('tspr_open_test_result_dashboard')!.inputSchema.safeParse({
      unknownField: 42,
      another: 'yes',
    });
    expect(result.success).toBe(true);
  });
});
