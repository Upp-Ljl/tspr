/**
 * Tests for src/report/html-renderer.ts
 *
 * Covers: all-pass, partial failures, all-failed, screenshots,
 * HTML structure, status pill classes, embedded patch, warnings.
 */

import { describe, it, expect } from 'vitest';
import { renderHtmlReport } from '../../src/report/html-renderer.js';
import type { RenderHtmlInput } from '../../src/report/html-renderer.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BASE: RenderHtmlInput = {
  runId: 'run-abc123def456',
  projectName: 'meme-weather',
  startedAt: new Date('2026-05-27T10:00:00Z'),
  durationMs: 4_231,
  provider: 'minimax',
  modelId: 'MiniMax-M2.7-highspeed',
  costUsd: 0.00042,
  totalTests: 5,
  passed: 5,
  failed: 0,
  skipped: 0,
  status: 'ok',
  warnings: [],
  failures: [],
  passes: [
    { testId: 'aabbcc112233', title: 'GET /api/memes returns 200', durationMs: 210 },
    { testId: 'ddeeff445566', title: 'GET /api/radar returns 200', durationMs: 185 },
    { testId: 'ffaabb778899', title: 'GET /api/graveyard returns 200', durationMs: 201 },
    { testId: '112233ccddee', title: 'GET /api/settle/valid returns 200', durationMs: 399 },
    { testId: '223344aabbcc', title: 'GET /api/settle/invalid returns 404', durationMs: 150 },
  ],
};

const WITH_FAILURES: RenderHtmlInput = {
  ...BASE,
  totalTests: 5,
  passed: 3,
  failed: 2,
  skipped: 0,
  status: 'partial',
  warnings: ['Scenario count (43) exceeds the MVP-0 cap of 10. Truncating to the first 10 scenarios.'],
  failures: [
    {
      testId: 'fail001aabbcc',
      title: 'GET /api/memes should return 200 OK with valid response structure',
      stack: 'Error: STACK_TRACE_ERROR\n    at task (/tspr-runtime/node_modules/@vitest/runner/dist/chunk.js:1784:27)\n    at Object.<anonymous> (/tspr-runtime/tests/meme-weather.spec.ts:8:5)',
      durationMs: 312,
      suggestedFixRegion: {
        file: 'tests/meme-weather.spec.ts',
        lineStart: 1,
        lineEnd: 10,
        why: 'Test failed — check the stack trace for the root cause.',
      },
      suggestedPatch: `--- a/tests/meme-weather.spec.ts\n+++ b/tests/meme-weather.spec.ts\n@@ -5,7 +5,7 @@\n-const BASE_URL = 'http://localhost:3000';\n+const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';`,
    },
    {
      testId: 'fail002ccddee',
      title: 'GET /api/settle/[week] should return 200 OK with settlement data for valid week',
      stack: 'AssertionError: expected 404 to be 200 // Object.is equality\n    at /tspr-runtime/tests/meme-weather.spec.ts:46:31',
      durationMs: 198,
      suggestedFixRegion: {
        file: 'tests/meme-weather.spec.ts',
        lineStart: 40,
        lineEnd: 50,
        why: 'Route /api/settle/:week not implemented yet.',
      },
    },
  ],
  passes: BASE.passes!.slice(0, 3),
};

const ALL_FAILED: RenderHtmlInput = {
  ...BASE,
  totalTests: 3,
  passed: 0,
  failed: 3,
  skipped: 0,
  status: 'all-failed',
  warnings: [],
  failures: [
    { testId: 'f1', title: 'Test A', stack: 'Error: something went wrong' },
    { testId: 'f2', title: 'Test B', stack: 'Error: timeout exceeded' },
    { testId: 'f3', title: 'Test C', stack: 'Error: connection refused' },
  ],
  passes: [],
};

const WITH_SCREENSHOT: RenderHtmlInput = {
  ...WITH_FAILURES,
  failures: [
    {
      ...WITH_FAILURES.failures[0],
      screenshotBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      domSnapshot: '<html><body><h1>Hello</h1></body></html>',
    },
    WITH_FAILURES.failures[1],
  ],
};

// ─── Test suite: all-pass ─────────────────────────────────────────────────────

describe('renderHtmlReport — all-pass', () => {
  it('returns a complete HTML document', () => {
    const html = renderHtmlReport(BASE);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('</html>');
    expect(html.trim().endsWith('</html>')).toBe(true);
  });

  it('contains project name in <title>', () => {
    const html = renderHtmlReport(BASE);
    expect(html).toContain('<title>tspr Report — meme-weather</title>');
  });

  it('status pill class is "ok" and label is all-passed', () => {
    const html = renderHtmlReport(BASE);
    expect(html).toContain('status-pill ok');
    expect(html).toContain('All Tests Passed');
  });

  it('runId appears in header meta and footer', () => {
    const html = renderHtmlReport(BASE);
    expect(html).toContain('run-abc123def456');
    expect(html).toContain('footer-runid');
  });

  it('shows correct stats', () => {
    const html = renderHtmlReport(BASE);
    // pass rate 100%
    expect(html).toContain('100%');
    // provider and model
    expect(html).toContain('minimax');
    expect(html).toContain('MiniMax-M2.7-highspeed');
  });

  it('renders pass table rows', () => {
    const html = renderHtmlReport(BASE);
    expect(html).toContain('GET /api/memes returns 200');
    expect(html).toContain('pass-table');
  });
});

// ─── Test suite: partial failures ────────────────────────────────────────────

describe('renderHtmlReport — partial failures', () => {
  it('status pill class is "partial"', () => {
    const html = renderHtmlReport(WITH_FAILURES);
    expect(html).toContain('status-pill partial');
    expect(html).toContain('Partial Failure');
  });

  it('renders failure cards for each failure', () => {
    const html = renderHtmlReport(WITH_FAILURES);
    expect(html).toContain('failure-card');
    expect(html).toContain('GET /api/memes should return 200 OK with valid response structure');
    expect(html).toContain('GET /api/settle/[week] should return 200 OK with settlement data for valid week');
  });

  it('renders stack trace inside <pre><code>', () => {
    const html = renderHtmlReport(WITH_FAILURES);
    expect(html).toContain('<pre class="stack-trace"><code>');
    expect(html).toContain('STACK_TRACE_ERROR');
  });

  it('renders suggested patch inside <pre><code> with diff-add class', () => {
    const html = renderHtmlReport(WITH_FAILURES);
    expect(html).toContain('<pre class="patch-diff"><code>');
    expect(html).toContain('diff-add');
    expect(html).toContain('diff-del');
    expect(html).toContain('diff-hunk');
    expect(html).toContain('TEST_BASE_URL');
  });

  it('renders fix-region with file + lines', () => {
    const html = renderHtmlReport(WITH_FAILURES);
    expect(html).toContain('fix-region');
    expect(html).toContain('tests/meme-weather.spec.ts');
    expect(html).toContain('1–10');
  });

  it('renders warnings section', () => {
    const html = renderHtmlReport(WITH_FAILURES);
    expect(html).toContain('warning-item');
    expect(html).toContain('Scenario count (43) exceeds the MVP-0 cap of 10');
  });

  it('progress bar has all three segments', () => {
    const html = renderHtmlReport(WITH_FAILURES);
    expect(html).toContain('bar-pass');
    expect(html).toContain('bar-fail');
    expect(html).toContain('bar-skip');
  });
});

// ─── Test suite: all-failed ───────────────────────────────────────────────────

describe('renderHtmlReport — all-failed', () => {
  it('status pill class is "all-failed"', () => {
    const html = renderHtmlReport(ALL_FAILED);
    expect(html).toContain('status-pill all-failed');
    expect(html).toContain('All Tests Failed');
  });

  it('renders three failure cards', () => {
    const html = renderHtmlReport(ALL_FAILED);
    const count = (html.match(/class="failure-card"/g) ?? []).length;
    expect(count).toBe(3);
  });

  it('pass rate shows 0%', () => {
    const html = renderHtmlReport(ALL_FAILED);
    expect(html).toContain('0%');
  });
});

// ─── Test suite: screenshot + DOM snapshot ────────────────────────────────────

describe('renderHtmlReport — screenshot + DOM snapshot', () => {
  it('embeds screenshot as base64 data URI', () => {
    const html = renderHtmlReport(WITH_SCREENSHOT);
    expect(html).toContain('data:image/png;base64,');
    expect(html).toContain('iVBORw0KGgo');
    expect(html).toContain('screenshot-img');
  });

  it('includes DOM snapshot inside pre.dom-snapshot (hidden by default)', () => {
    const html = renderHtmlReport(WITH_SCREENSHOT);
    expect(html).toContain('dom-snapshot hidden');
    expect(html).toContain('&lt;html&gt;');
  });

  it('is still valid HTML with screenshot embedded', () => {
    const html = renderHtmlReport(WITH_SCREENSHOT);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('</html>');
    expect(html).toContain('</body>');
  });
});

// ─── Test suite: generatedTestsSource ────────────────────────────────────────

describe('renderHtmlReport — generatedTestsSource', () => {
  it('renders source section when provided', () => {
    const html = renderHtmlReport({
      ...BASE,
      generatedTestsSource: `import { describe, it } from 'vitest';\ndescribe('x', () => { it('y', () => {}); });`,
    });
    expect(html).toContain('source-code');
    expect(html).toContain('source-toggle-btn');
    // collapsed by default
    expect(html).toContain('id="source-wrap"');
    expect(html).toContain('▶ Show generated test source');
  });

  it('does not render source section when not provided', () => {
    const html = renderHtmlReport(BASE);
    // The id="source-toggle-btn" element should not be present (JS string refs inside <script> are fine)
    expect(html).not.toContain('id="source-toggle-btn"');
    // The id="source-wrap" element should not be present
    expect(html).not.toContain('id="source-wrap"');
  });
});

// ─── Test suite: escaping ─────────────────────────────────────────────────────

describe('renderHtmlReport — XSS escaping', () => {
  it('escapes HTML in project name', () => {
    const html = renderHtmlReport({ ...BASE, projectName: '<script>alert(1)</script>' });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes HTML in failure title', () => {
    const html = renderHtmlReport({
      ...BASE,
      status: 'all-failed',
      failed: 1,
      passed: 0,
      totalTests: 1,
      failures: [{ testId: 'x1', title: '<img src=x onerror=alert(1)>', stack: 'err' }],
    });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });
});

// ─── Test suite: dark mode CSS ────────────────────────────────────────────────

describe('renderHtmlReport — CSS / dark mode', () => {
  it('includes prefers-color-scheme: dark media query', () => {
    const html = renderHtmlReport(BASE);
    expect(html).toContain('prefers-color-scheme: dark');
  });

  it('includes responsive mobile breakpoint', () => {
    const html = renderHtmlReport(BASE);
    expect(html).toContain('@media (max-width: 600px)');
  });
});
