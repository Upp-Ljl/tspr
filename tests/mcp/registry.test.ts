/**
 * Tests for MCP registry — tool roster and dispatch
 * Covers: B-0-2, B-0-4, B-10-1, B-9-1, B-9-2, TOOLNAME-001/002
 */
import { describe, it, expect } from 'vitest';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_DEFINITIONS, TOOL_MAP } from '../../src/mcp/registry.js';
import { makeContext } from './helpers.js';

const EXPECTED_TOOL_NAMES = [
  'localsprite_bootstrap_tests',
  'localsprite_generate_code_summary',
  'localsprite_generate_standardized_prd',
  'localsprite_generate_frontend_test_plan',
  'localsprite_generate_backend_test_plan',
  'localsprite_generate_code_and_execute',
  'localsprite_open_test_result_dashboard',
  'localsprite_rerun_tests',
];

describe('Tool Registry', () => {
  // ─── B-0-2/B-10-1: exactly 8 tools with required fields ──────────────────
  it('LIFECYCLE-002: TOOL_DEFINITIONS has exactly 8 entries', () => {
    expect(TOOL_DEFINITIONS.length).toBe(8);
  });

  it('LIFECYCLE-002: all 8 tool names are exactly correct (case-sensitive)', () => {
    const names = TOOL_DEFINITIONS.map((td) => td.name).sort();
    expect(names).toEqual([...EXPECTED_TOOL_NAMES].sort());
  });

  it('LIFECYCLE-002: each tool definition has name (string) and inputSchema (object)', () => {
    for (const td of TOOL_DEFINITIONS) {
      expect(typeof td.name).toBe('string');
      expect(td.name.length).toBeGreaterThan(0);
      expect(td.inputSchema).toBeDefined();
      expect(typeof td.inputSchema.safeParse).toBe('function');
      expect(typeof td.handler).toBe('function');
    }
  });

  // ─── TOOL_MAP contains all tools ─────────────────────────────────────────
  it('TOOL_MAP contains all 8 tools keyed by name', () => {
    expect(TOOL_MAP.size).toBe(8);
    for (const name of EXPECTED_TOOL_NAMES) {
      expect(TOOL_MAP.has(name)).toBe(true);
    }
  });

  // ─── B-0-4/B-E-4: unknown tool name not in map ────────────────────────────
  it('TOOLNAME-001: unknown tool not in TOOL_MAP', () => {
    expect(TOOL_MAP.has('localsprite_does_not_exist')).toBe(false);
  });

  it('TOOLNAME-002: wrong case tool not in TOOL_MAP (case-sensitive)', () => {
    expect(TOOL_MAP.has('LocalSprite_Bootstrap_Tests')).toBe(false);
    expect(TOOL_MAP.has('LOCALSPRITE_BOOTSTRAP_TESTS')).toBe(false);
  });

  // ─── B-9-2: sequential calls complete independently ───────────────────────
  it('CONCUR-002: sequential dashboard calls both return status=ok', async () => {
    const ctx = makeContext();
    const dashboardTool = TOOL_MAP.get('localsprite_open_test_result_dashboard')!;

    const r1 = await dashboardTool.handler({}, ctx);
    const r2 = await dashboardTool.handler({}, ctx);

    const p1 = JSON.parse(r1.content[0].text) as { status: string };
    const p2 = JSON.parse(r2.content[0].text) as { status: string };

    expect(p1.status).toBe('ok');
    expect(p2.status).toBe('ok');
  });

  // ─── Input schema: each tool's schema validates correctly ─────────────────
  it('each tool rejects missing required fields (B-V-0)', () => {
    // Test a representative sample
    const bootstrapSchema = TOOL_MAP.get('localsprite_bootstrap_tests')!.inputSchema;
    const resultBootstrap = bootstrapSchema.safeParse({});
    expect(resultBootstrap.success).toBe(false);

    const summarySchema = TOOL_MAP.get('localsprite_generate_code_summary')!.inputSchema;
    const resultSummary = summarySchema.safeParse({});
    expect(resultSummary.success).toBe(false);

    const prdSchema = TOOL_MAP.get('localsprite_generate_standardized_prd')!.inputSchema;
    const resultPrd = prdSchema.safeParse({});
    expect(resultPrd.success).toBe(false);

    const beplanSchema = TOOL_MAP.get('localsprite_generate_backend_test_plan')!.inputSchema;
    const resultBeplan = beplanSchema.safeParse({});
    expect(resultBeplan.success).toBe(false);

    const executeSchema = TOOL_MAP.get('localsprite_generate_code_and_execute')!.inputSchema;
    const resultExecute = executeSchema.safeParse({});
    expect(resultExecute.success).toBe(false);

    const rerunSchema = TOOL_MAP.get('localsprite_rerun_tests')!.inputSchema;
    const resultRerun = rerunSchema.safeParse({});
    expect(resultRerun.success).toBe(false);
  });

  // ─── Dashboard tool accepts empty input (B-V-4) ────────────────────────────
  it('dashboard tool schema accepts empty object (B-V-4)', () => {
    const dashboardSchema = TOOL_MAP.get('localsprite_open_test_result_dashboard')!.inputSchema;
    const result = dashboardSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  // ─── All tool names match their positions in TOOL_DEFINITIONS ─────────────
  it('tool order is deterministic', () => {
    const names = TOOL_DEFINITIONS.map((td) => td.name);
    // First tool is always bootstrap
    expect(names[0]).toBe('localsprite_bootstrap_tests');
    // Last tool is always rerun
    expect(names[7]).toBe('localsprite_rerun_tests');
  });
});
