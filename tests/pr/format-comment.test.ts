/**
 * tests/pr/format-comment.test.ts
 *
 * Unit tests for formatPrComment() — pure function, no I/O.
 *
 * New format (TestSprite-style):
 *   - Compact status header (no 8-column table)
 *   - Full scenario list with ✅/❌ per row + severity badge
 *   - Failures section with file:line, Fix hint, apply hint, patch diff
 *   - Single footer link
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
        testId: 'SETT-001',
        issueId: '7d3fabc0',
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
        testId: 'MEME-001',
        issueId: '2c8edef0',
        title: 'GET /api/memes should return 200 OK',
        stack: 'Error: STACK_TRACE_ERROR\n    at task (vitest/runner.js:1784:27)',
      },
    ],
    scenarios: [
      {
        id: 'RADAR-001',
        title: 'Successfully retrieve radar map data',
        endpoint: 'GET /api/radar',
        type: 'happy-path',
      },
      {
        id: 'PROF-001',
        title: 'Successfully retrieve authenticated user profile',
        endpoint: 'GET /api/me/profile',
        type: 'auth',
      },
      {
        id: 'SETT-001',
        title: 'Successfully retrieve settlement data',
        endpoint: 'GET /api/settle/:week',
        type: 'happy-path',
      },
      {
        id: 'MEME-001',
        title: 'Successfully retrieve paginated list of memes',
        endpoint: 'GET /api/memes',
        type: 'happy-path',
      },
    ],
    ...overrides,
  };
}

// ─── T1: Status label in header ───────────────────────────────────────────────
describe('status header', () => {
  it('T1: ok status shows ✅ all passed', () => {
    const md = formatPrComment(baseInput({ status: 'ok', failed: 0, passed: 5, failures: [] }));
    expect(md).toContain('✅ all passed');
  });

  it('T2: partial status shows ⚠️ partial', () => {
    const md = formatPrComment(baseInput({ status: 'partial' }));
    expect(md).toContain('⚠️ partial');
  });

  it('T3: all-failed status shows ❌ all failed', () => {
    const md = formatPrComment(baseInput({ status: 'all-failed', failed: 5, passed: 0, failures: [] }));
    expect(md).toContain('❌ all failed');
  });
});

// ─── T4: Compact header block ─────────────────────────────────────────────────
describe('compact header', () => {
  it('T4: header contains project name, pass count, fail count, duration', () => {
    const md = formatPrComment(baseInput({
      passed: 3,
      failed: 2,
      durationMs: 29000,
    }));
    expect(md).toContain('meme-weather');
    expect(md).toContain('3 pass');
    expect(md).toContain('2 fail');
    expect(md).toContain('29s');
  });

  it('T5: header does NOT use 8-column markdown table', () => {
    const md = formatPrComment(baseInput());
    // Old format had "| Project | Run | Total | Pass | Fail | Skip | Duration | Model |"
    expect(md).not.toMatch(/\|\s*Project\s*\|\s*Run\s*\|/);
    expect(md).not.toMatch(/\|\s*Total\s*\|/);
  });

  it('T6: runId appears in header (truncated to 8 chars)', () => {
    const md = formatPrComment(baseInput({ runId: 'abc123def456xyz' }));
    expect(md).toContain('`abc123de`');
  });
});

// ─── T7: Scenarios list ───────────────────────────────────────────────────────
describe('scenarios list', () => {
  it('T7: full scenario list shown with ✅/❌ per row', () => {
    const md = formatPrComment(baseInput());
    // Passing scenarios
    expect(md).toContain('✅');
    // Failing scenarios
    expect(md).toContain('❌');
    // Scenario titles present
    expect(md).toContain('Successfully retrieve radar map data');
    expect(md).toContain('Successfully retrieve settlement data');
  });

  it('T8: severity badges present per scenario row', () => {
    const md = formatPrComment(baseInput());
    // auth type → [Critical]
    expect(md).toContain('[Critical]');
    // happy-path → [Major]
    expect(md).toContain('[Major]');
  });

  it('T9: no scenarios section when scenarios array absent', () => {
    const md = formatPrComment(baseInput({ scenarios: undefined }));
    // Should not have a ### Scenarios heading
    expect(md).not.toContain('### Scenarios');
  });
});

// ─── T10: Failures section with file:line ─────────────────────────────────────
describe('failures section', () => {
  it('T10: failure shows correct file:line from suggestedFixRegion', () => {
    const md = formatPrComment(baseInput());
    expect(md).toContain('app/api/settle/[week]/route.ts:18');
  });

  it('T11: failure heading contains test title', () => {
    const md = formatPrComment(baseInput());
    expect(md).toContain('GET /api/settle/[week] expected 200 got 404');
  });

  it('T12: fix hint (why) is included in failures', () => {
    const md = formatPrComment(baseInput());
    expect(md).toContain('Route handler returns 404 instead of 200');
  });

  it('T13: apply hint with short issue id is present', () => {
    const md = formatPrComment(baseInput());
    // issueId '7d3fabc0' → short '7d3f'
    expect(md).toContain('tspr apply-fix 7d3f');
    expect(md).toContain('apply tspr fix 7d3f');
  });
});

// ─── T14: Truncation ─────────────────────────────────────────────────────────
describe('truncation', () => {
  it('T14: shows ≤5 failures inline and "and N more" for overflow', () => {
    const manyFailures = Array.from({ length: 8 }, (_, i) => ({
      testId: `f${i}`,
      issueId: `issue${i}abc`.padEnd(8, '0'),
      title: `Test ${i} fails`,
      stack: `Error at test${i}.ts:${i + 1}:1`,
    }));
    const md = formatPrComment(
      baseInput({ failures: manyFailures, failed: 8, status: 'all-failed' }),
    );
    // Should mention the overflow
    expect(md).toContain('and 3 more');
  });

  it('T15: exactly 5 failures shows no overflow message', () => {
    const fiveFailures = Array.from({ length: 5 }, (_, i) => ({
      testId: `f${i}`,
      issueId: `issue${i}`.padEnd(8, '0'),
      title: `Test ${i} fails`,
    }));
    const md = formatPrComment(
      baseInput({ failures: fiveFailures, failed: 5, status: 'all-failed' }),
    );
    expect(md).not.toMatch(/and \d+ more/);
  });
});

// ─── T16: Zero failures ───────────────────────────────────────────────────────
describe('zero failures', () => {
  it('T16: shows No failures section when failed=0', () => {
    const md = formatPrComment(
      baseInput({ failed: 0, passed: 5, failures: [], status: 'ok' }),
    );
    expect(md).toContain('No failures');
    // No failure headings
    expect(md).not.toMatch(/#### ❌ issue-/);
  });
});

// ─── T17: Report / dashboard URL ─────────────────────────────────────────────
describe('report URL', () => {
  it('T17: includes dashboard URL in footer when provided', () => {
    const md = formatPrComment(
      baseInput({ dashboardUrl: 'http://localhost:7654/runs/abc' }),
    );
    expect(md).toContain('http://localhost:7654/runs/abc');
    expect(md).toContain('Full report');
  });

  it('T18: no footer link when neither reportUrl nor dashboardUrl provided', () => {
    const md = formatPrComment(
      baseInput({ reportUrl: undefined, dashboardUrl: undefined }),
    );
    expect(md).not.toContain('Full report ↗');
  });

  it('T19: dashboardUrl takes priority over reportUrl in footer', () => {
    const md = formatPrComment(
      baseInput({
        dashboardUrl: 'http://localhost:7654/runs/abc',
        reportUrl: 'file:///some/report.html',
      }),
    );
    expect(md).toContain('http://localhost:7654/runs/abc');
  });
});

// ─── T20: Suggested patch embedded ───────────────────────────────────────────
describe('suggested patch', () => {
  it('T20: patch rendered as diff block inside collapsible details', () => {
    const md = formatPrComment(
      baseInput({
        failures: [
          {
            testId: 'p1',
            issueId: 'abcd0001',
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
    expect(md).toContain('<details>');
    expect(md).toContain('Suggested patch');
  });
});

// ─── T21: Stack trace in details ─────────────────────────────────────────────
describe('stack trace', () => {
  it('T21: stack trace wrapped in collapsible details block', () => {
    const md = formatPrComment(baseInput());
    expect(md).toContain('<details>');
    expect(md).toContain('Stack trace');
    expect(md).toContain('AssertionError: expected 404 to be 200');
  });
});

// ─── T22: Skipped count ───────────────────────────────────────────────────────
describe('skipped count', () => {
  it('T22: skipped count shown in header only when > 0', () => {
    const withSkip = formatPrComment(baseInput({ skipped: 2 }));
    expect(withSkip).toContain('2 skipped');

    const noSkip = formatPrComment(baseInput({ skipped: 0 }));
    expect(noSkip).not.toContain('skipped');
  });
});
