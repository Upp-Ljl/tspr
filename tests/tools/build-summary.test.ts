/**
 * tests/tools/build-summary.test.ts
 *
 * Unit tests for buildSummary() — the TestSprite-style cc chat block.
 * Also tests relativizeFilePath helper.
 *
 * Tests are isolated: buildSummary is a pure string builder.
 */
import { describe, it, expect } from 'vitest';
import { buildSummary, relativizeFilePath } from '../../src/tools/generateAndExecute.js';
import type { ExecuteResult } from '../../src/tools/generateAndExecute.js';

type Failures = ExecuteResult['failures'];

const NO_FAILURES: Failures = [];

const SOME_FAILURES: Failures = [
  {
    testId: 'SETT-001',
    issueId: '7d3fabc0ef012345',
    title: 'meme-weather API Integration Tests GET /api/settle/[week] should return 200',
    stack: 'AssertionError: expected 404 to be 200\n    at /tspr-runtime/tests/meme-weather.spec.ts:46:31',
    suggestedFixRegion: {
      file: '..\\..\\tspr-runtime\\tests\\meme-weather.spec.ts',
      lineStart: 1,
      lineEnd: 10,
      why: 'Test failed — check the stack trace for the root cause.',
    },
  },
  {
    testId: 'MEME-001',
    issueId: '2c8edef012345678',
    title: 'meme-weather API Integration Tests GET /api/memes should return 200 OK with valid response structure',
    stack: 'Error: STACK_TRACE_ERROR\n    at task (vitest/runner.js:1784:27)',
    suggestedFixRegion: {
      file: '..\\..\\tspr-runtime\\tests\\meme-weather.spec.ts',
      lineStart: 8,
      lineEnd: 12,
      why: 'vitest collect error — test setup issue, not product bug.',
    },
  },
];

const SCENARIOS = [
  { id: 'RADAR-001', title: 'GET /api/radar — returns trending memes', endpoint: 'GET /api/radar', type: 'happy-path' },
  { id: 'GRAV-001', title: 'GET /api/graveyard — returns dead-meme history', endpoint: 'GET /api/graveyard', type: 'happy-path' },
  { id: 'PROF-001', title: 'GET /api/me/profile — current user profile', endpoint: 'GET /api/me/profile', type: 'auth' },
  { id: 'SETT-001', title: 'GET /api/settle/[week] — expected 200, got 404', endpoint: 'GET /api/settle/:week', type: 'happy-path' },
  { id: 'MEME-001', title: 'GET /api/memes — vitest collect error', endpoint: 'GET /api/memes', type: 'happy-path' },
];

function makeSummary(overrides: {
  totalTests?: number;
  passed?: number;
  failed?: number;
  skipped?: number;
  failures?: Failures;
  warnings?: string[];
  modelId?: string;
  durationMs?: number;
  runId?: string;
  reportPath?: string;
  allScenarios?: typeof SCENARIOS;
} = {}): string {
  return buildSummary(
    'meme-weather',
    overrides.totalTests ?? 5,
    overrides.passed ?? 3,
    overrides.failed ?? 2,
    overrides.skipped ?? 0,
    overrides.failures ?? SOME_FAILURES,
    overrides.warnings ?? [],
    overrides.modelId ?? 'MiniMax-M2.7-highspeed',
    overrides.durationMs ?? 29000,
    overrides.runId ?? 'a0870d9412345678',
    overrides.reportPath ?? 'D:\\lll\\meme-weather\\.tspr\\report.html',
    overrides.allScenarios ?? SCENARIOS,
  );
}

// ─── SUM-001: Header line ─────────────────────────────────────────────────────
describe('header line', () => {
  it('SUM-001: header contains project name and duration', () => {
    const md = makeSummary();
    expect(md).toContain('meme-weather');
    expect(md).toContain('29s');
  });

  it('SUM-002: header mentions scenario count', () => {
    const md = makeSummary({ totalTests: 5 });
    expect(md).toContain('5 scenario');
  });
});

// ─── SUM-003: Stats line ──────────────────────────────────────────────────────
describe('stats line', () => {
  it('SUM-003: stats line shows pass · fail · model · runId', () => {
    const md = makeSummary();
    expect(md).toContain('3 pass');
    expect(md).toContain('2 fail');
    expect(md).toContain('MiniMax-M2.7-highspeed');
    expect(md).toContain('`a0870d94`');
  });

  it('SUM-004: skipped shown only when > 0', () => {
    const withSkip = makeSummary({ skipped: 1, totalTests: 6 });
    expect(withSkip).toContain('1 skipped');

    const noSkip = makeSummary({ skipped: 0 });
    expect(noSkip).not.toMatch(/\d+ skipped/);
  });
});

// ─── SUM-005: Full scenario list ─────────────────────────────────────────────
describe('full scenario list', () => {
  it('SUM-005: full scenario list is shown with ✅/❌ per row', () => {
    const md = makeSummary();
    // Should show all 5 scenarios
    expect(md).toContain('GET /api/radar');
    expect(md).toContain('GET /api/graveyard');
    expect(md).toContain('GET /api/me/profile');
    expect(md).toContain('GET /api/settle/[week]');
    expect(md).toContain('GET /api/memes');
  });

  it('SUM-006: passing scenarios show ✅, failing show ❌', () => {
    const md = makeSummary();
    // RADAR-001 should be ✅ (not in failures)
    expect(md).toMatch(/✅.*GET \/api\/radar/);
    // SETT-001 should be ❌ (in failures)
    expect(md).toMatch(/❌.*GET \/api\/settle/);
  });

  it('SUM-007: severity badges present per scenario row', () => {
    const md = makeSummary();
    // auth type → [Critical]
    expect(md).toContain('[Critical]');
    // happy-path → [Major]
    expect(md).toContain('[Major]');
  });
});

// ─── SUM-008: Failures section ───────────────────────────────────────────────
describe('failures detail', () => {
  it('SUM-008: failures section header present when failed > 0', () => {
    const md = makeSummary();
    expect(md).toContain('**Failures**');
  });

  it('SUM-009: no failures section when failed = 0', () => {
    const md = makeSummary({ failed: 0, passed: 5, failures: [] });
    expect(md).not.toContain('**Failures**');
  });

  it('SUM-010: each failure shows issue-XXXX with short id', () => {
    const md = makeSummary();
    // issueId '7d3fabc0ef012345' → short '7d3f'
    expect(md).toContain('issue-7d3f');
  });

  it('SUM-011: each failure shows severity badge', () => {
    const md = makeSummary();
    // SETT-001 type=happy-path → [Major]
    expect(md).toMatch(/issue-7d3f.*\[Major\]/);
  });

  it('SUM-012: file path shown — container paths relativized', () => {
    const md = makeSummary();
    // "..\\..\\tspr-runtime\\tests\\meme-weather.spec.ts" → "tspr-generated/meme-weather.spec.ts"
    expect(md).toContain('tspr-generated/meme-weather.spec.ts');
    // Must NOT expose the raw container path
    expect(md).not.toContain('..\\..\\tspr-runtime');
  });

  it('SUM-013: fix hint (why) shown', () => {
    const md = makeSummary();
    expect(md).toContain('Test failed — check the stack trace');
  });

  it('SUM-014: apply hint with short issue id shown', () => {
    const md = makeSummary();
    expect(md).toContain('tspr apply-fix 7d3f');
    expect(md).toContain('apply tspr fix 7d3f');
  });
});

// ─── SUM-015: Footer ─────────────────────────────────────────────────────────
describe('footer', () => {
  it('SUM-015: footer contains local report link', () => {
    const md = makeSummary();
    expect(md).toContain('[Local report]');
    expect(md).toContain('file:///');
  });

  it('SUM-016: footer contains dashboard link', () => {
    const md = makeSummary();
    expect(md).toContain('[Dashboard](http://localhost:7654)');
  });

  it('SUM-017: footer does NOT contain raw Windows path without link', () => {
    const md = makeSummary();
    // Old format had a bare line "Local report: file:///D:\..." — now it's a markdown link
    expect(md).not.toMatch(/^Local report: /m);
  });
});

// ─── SUM-018: Warnings ───────────────────────────────────────────────────────
describe('warnings', () => {
  it('SUM-018: warnings shown as blockquotes', () => {
    const md = makeSummary({ warnings: ['Scenario count (43) exceeds the MVP-0 cap of 10.'] });
    expect(md).toContain('> ⚠️');
    expect(md).toContain('Scenario count (43)');
  });
});

// ─── SUM-019: Fallback (no scenarios) ────────────────────────────────────────
describe('fallback without scenarios', () => {
  it('SUM-019: works without allScenarios (graceful fallback)', () => {
    const md = buildSummary(
      'meme-weather', 5, 3, 2, 0,
      SOME_FAILURES, [], 'MiniMax', 29000,
      'run123', 'D:\\lll\\report.html',
      undefined, // no scenarios
    );
    // Should still produce valid output
    expect(md).toContain('meme-weather');
    expect(md).toContain('**Failures**');
    expect(md).toContain('[Dashboard]');
  });
});

// ─── relativizeFilePath ───────────────────────────────────────────────────────
describe('relativizeFilePath', () => {
  it('REL-001: tspr-runtime/tests path → tspr-generated/filename', () => {
    const result = relativizeFilePath('../../tspr-runtime/tests/meme-weather.spec.ts');
    expect(result).toBe('tspr-generated/meme-weather.spec.ts');
  });

  it('REL-002: backslash path with tspr-runtime → tspr-generated/filename', () => {
    const result = relativizeFilePath('..\\..\\tspr-runtime\\tests\\meme-weather.spec.ts');
    expect(result).toBe('tspr-generated/meme-weather.spec.ts');
  });

  it('REL-003: leading ../../ traversal is stripped', () => {
    const result = relativizeFilePath('../../some/other/file.ts');
    expect(result).toBe('some/other/file.ts');
  });

  it('REL-004: src/ path stays as src/ relative', () => {
    const result = relativizeFilePath('D:/lll/project/src/api/route.ts');
    expect(result).toBe('src/api/route.ts');
  });

  it('REL-005: app/ path stays as app/ relative', () => {
    const result = relativizeFilePath('/home/user/project/app/api/route.ts');
    expect(result).toBe('app/api/route.ts');
  });

  it('REL-006: already short path returned as-is', () => {
    const result = relativizeFilePath('app/api/route.ts');
    expect(result).toBe('app/api/route.ts');
  });
});
