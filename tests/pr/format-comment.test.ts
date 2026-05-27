/**
 * tests/pr/format-comment.test.ts
 *
 * Unit tests for formatPrComment() — pure function, no I/O.
 * ≥8 tests covering:
 *   - Status pill per status value
 *   - 8-column markdown table
 *   - Failures section with file:line
 *   - Truncation at 5 with overflow notice
 *   - No failures section omitted when failed=0
 *   - Report URL footer included only when provided
 */

import { describe, it, expect } from 'vitest';
import { formatPrComment, type FormatCommentInput } from '../../src/pr/format-comment.js';

function baseInput(overrides: Partial<FormatCommentInput> = {}): FormatCommentInput {
  return {
    runId: 'abc123def456',
    projectName: 'meme-weather',
    startedAt: new Date('2026-05-26T10:00:00Z'),
    durationMs: 29000,
    totalTests: 5,
    passed: 3,
    failed: 2,
    skipped: 0,
    status: 'partial',
    failures: [
      {
        testId: 'f1',
        title: 'GET /api/settle/[week] expected 200 got 404',
        stack:
          'AssertionError: expected 404 to be 200\n    at /tspr-runtime/tests/meme-weather.spec.ts:46:31\n    at processTicksAndRejections (node:internal/process/task_queues:104:5)',
        suggestedFixRegion: {
          file: 'app/api/settle/[week]/route.ts',
          lineStart: 18,
          lineEnd: 25,
          why: 'Route handler returns 404 instead of 200',
        },
      },
      {
        testId: 'f2',
        title: 'GET /api/memes should return 200 OK',
        stack: 'Error: STACK_TRACE_ERROR\n    at task (vitest/runner.js:1784:27)',
      },
    ],
    ...overrides,
  };
}

// ─── T1: Status pill — ok ─────────────────────────────────────────────────────
describe('status pill', () => {
  it('T1: ok status shows ✅', () => {
    const md = formatPrComment(baseInput({ status: 'ok', failed: 0, passed: 5 }));
    expect(md).toContain('✅ ok');
  });

  it('T2: partial status shows ⚠️', () => {
    const md = formatPrComment(baseInput({ status: 'partial' }));
    expect(md).toContain('⚠️ partial');
  });

  it('T3: all-failed status shows ❌', () => {
    const md = formatPrComment(baseInput({ status: 'all-failed', failed: 5, passed: 0 }));
    expect(md).toContain('❌ all-failed');
  });
});

// ─── T4: 8-column table ───────────────────────────────────────────────────────
describe('summary table', () => {
  it('T4: table has 8 pipe-separated columns in header', () => {
    const md = formatPrComment(baseInput());
    // Header row: | Project | Run | Total | Pass | Fail | Skip | Duration | Model |
    expect(md).toMatch(/\|\s*Project\s*\|/);
    expect(md).toMatch(/\|\s*Run\s*\|/);
    expect(md).toMatch(/\|\s*Total\s*\|/);
    expect(md).toMatch(/\|\s*Pass\s*\|/);
    expect(md).toMatch(/\|\s*Fail\s*\|/);
    expect(md).toMatch(/\|\s*Skip\s*\|/);
    expect(md).toMatch(/\|\s*Duration\s*\|/);
    expect(md).toMatch(/\|\s*Model\s*\|/);
  });

  it('T5: table data row contains all provided counts', () => {
    const md = formatPrComment(baseInput({
      totalTests: 10,
      passed: 7,
      failed: 2,
      skipped: 1,
      durationMs: 29000,
    }));
    expect(md).toContain('| meme-weather |');
    expect(md).toContain('| 10 |');
    expect(md).toContain('| 7 |');
    expect(md).toContain('| 2 |');
    expect(md).toContain('| 1 |');
    expect(md).toContain('29s');
  });
});

// ─── T6: Failures section with file:line ─────────────────────────────────────
describe('failures section', () => {
  it('T6: failure shows correct file:line from suggestedFixRegion', () => {
    const md = formatPrComment(baseInput());
    expect(md).toContain('app/api/settle/[week]/route.ts:18');
  });

  it('T7: failure heading contains test title', () => {
    const md = formatPrComment(baseInput());
    expect(md).toContain('GET /api/settle/[week] expected 200 got 404');
  });
});

// ─── T8: Truncation at 5 ─────────────────────────────────────────────────────
describe('truncation', () => {
  it('T8: shows ≤5 failures inline and "and N more" for overflow', () => {
    const manyFailures = Array.from({ length: 8 }, (_, i) => ({
      testId: `f${i}`,
      title: `Test ${i} fails`,
      stack: `Error at test${i}.ts:${i + 1}:1`,
    }));
    const md = formatPrComment(
      baseInput({ failures: manyFailures, failed: 8, status: 'all-failed' }),
    );
    // Should have exactly 5 failure headings (#### N.)
    const headingMatches = md.match(/^#### \d+\./gm) ?? [];
    expect(headingMatches).toHaveLength(5);
    // Should mention the overflow
    expect(md).toContain('and 3 more');
  });

  it('T9: exactly 5 failures shows no overflow message', () => {
    const fiveFailures = Array.from({ length: 5 }, (_, i) => ({
      testId: `f${i}`,
      title: `Test ${i} fails`,
    }));
    const md = formatPrComment(
      baseInput({ failures: fiveFailures, failed: 5, status: 'all-failed' }),
    );
    const headingMatches = md.match(/^#### \d+\./gm) ?? [];
    expect(headingMatches).toHaveLength(5);
    expect(md).not.toContain('and 0 more');
    expect(md).not.toMatch(/and \d+ more/);
  });
});

// ─── T10: No failures section when failed=0 ──────────────────────────────────
describe('zero failures', () => {
  it('T10: failures section still present but shows no-failure message', () => {
    const md = formatPrComment(
      baseInput({ failed: 0, passed: 5, failures: [], status: 'ok' }),
    );
    // Must NOT omit the section — it should say "No failures"
    expect(md).toContain('No failures');
    // Must NOT contain failure headings
    expect(md).not.toMatch(/^#### \d+\./m);
  });
});

// ─── T11: Report URL ─────────────────────────────────────────────────────────
describe('report URL', () => {
  it('T11: includes report link when reportUrl is provided', () => {
    const md = formatPrComment(
      baseInput({ reportUrl: 'file:///D:/lll/meme-weather/.tspr/report.html' }),
    );
    expect(md).toContain('file:///D:/lll/meme-weather/.tspr/report.html');
    expect(md).toContain('Full report');
  });

  it('T12: no report link footer when neither reportUrl nor dashboardUrl provided', () => {
    const md = formatPrComment(
      baseInput({ reportUrl: undefined, dashboardUrl: undefined }),
    );
    // Should not have a footer link
    expect(md).not.toContain('Full report ↗');
  });

  it('T13: dashboardUrl takes priority over reportUrl in footer', () => {
    const md = formatPrComment(
      baseInput({
        dashboardUrl: 'http://localhost:7654/runs/abc',
        reportUrl: 'file:///some/report.html',
      }),
    );
    expect(md).toContain('http://localhost:7654/runs/abc');
  });
});

// ─── T14: suggestedPatch rendered as diff block ───────────────────────────────
describe('suggested patch', () => {
  it('T14: patch rendered as diff code block', () => {
    const md = formatPrComment(
      baseInput({
        failures: [
          {
            testId: 'p1',
            title: 'Some failing test',
            suggestedPatch: '- old line\n+ new line',
          },
        ],
        failed: 1,
      }),
    );
    expect(md).toContain('```diff');
    expect(md).toContain('- old line');
    expect(md).toContain('+ new line');
  });
});
