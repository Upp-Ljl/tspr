#!/usr/bin/env node
/**
 * scripts/render-report-demo.mjs
 *
 * One-shot demo: reads D:/lll/meme-weather/.tspr/test_results.json,
 * renders a pretty HTML report, writes it to .tspr/report.html.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Load the renderer ──────────────────────────────────────────────────────
// Try compiled dist first; fall back to ts-node / tsx path for dev mode.
let renderHtmlReport;

const distPath = path.join(__dirname, '..', 'dist', 'report', 'html-renderer.js');
const srcPath  = path.join(__dirname, '..', 'src', 'report', 'html-renderer.ts');

if (existsSync(distPath)) {
  const mod = await import(pathToFileURL(distPath).href);
  renderHtmlReport = mod.renderHtmlReport;
} else {
  // No dist? Try tsx/ts-node via dynamic import with register
  console.error('[demo] dist not found; run "npm run build" first, or use tsx:');
  console.error(`       npx tsx ${path.relative(process.cwd(), __dirname + '/render-report-demo.mjs')}`);
  // Attempt tsx loader if available
  try {
    const { createRequire: cr } = await import('module');
    // Last-resort: inline a tiny subset (parse JSON and template)
    throw new Error('skip');
  } catch {
    // Minimal fallback — build the HTML inline from JSON without the full renderer
    renderHtmlReport = buildFallbackHtml;
  }
}

// ── Paths ──────────────────────────────────────────────────────────────────
const MEME_WEATHER_TSPR = 'D:/lll/meme-weather/.tspr';
const INPUT_JSON = path.join(MEME_WEATHER_TSPR, 'test_results.json');
const OUTPUT_HTML = path.join(MEME_WEATHER_TSPR, 'report.html');

// ── Read fixture ───────────────────────────────────────────────────────────
let result;
if (existsSync(INPUT_JSON)) {
  console.log(`[demo] Reading: ${INPUT_JSON}`);
  result = JSON.parse(readFileSync(INPUT_JSON, 'utf-8'));
} else {
  console.warn(`[demo] ${INPUT_JSON} not found; using synthetic fixture.`);
  result = {
    status: 'partial',
    totalTests: 5,
    passed: 3,
    failed: 2,
    skipped: 0,
    warnings: ['Scenario count (43) exceeds the MVP-0 cap of 10. Truncating to the first 10 scenarios.'],
    failures: [
      {
        testId: 'meme-weather API Integration Tests GET /api/memes should return 200 OK',
        title: 'meme-weather API Integration Tests GET /api/memes should return 200 OK',
        stack: 'Error: STACK_TRACE_ERROR\n    at task (/tspr-runtime/node_modules/@vitest/runner/dist/chunk.js:1784:27)',
        suggestedFixRegion: { file: 'tests/meme-weather.spec.ts', lineStart: 1, lineEnd: 10, why: 'Test failed.' },
      },
      {
        testId: 'meme-weather API Integration Tests GET /api/settle should return 200 OK',
        title: 'meme-weather API Integration Tests GET /api/settle should return 200 OK',
        stack: 'AssertionError: expected 404 to be 200\n    at /tspr-runtime/tests/meme-weather.spec.ts:46:31',
        suggestedFixRegion: { file: 'tests/meme-weather.spec.ts', lineStart: 40, lineEnd: 50, why: 'Route not implemented.' },
      },
    ],
  };
}

// ── Build RenderHtmlInput from ExecuteResult ───────────────────────────────
const input = {
  runId: `run-${Date.now().toString(36)}`,
  projectName: 'meme-weather',
  startedAt: new Date(),
  durationMs: 4_231,
  provider: 'minimax',
  modelId: 'MiniMax-M2.7-highspeed',
  costUsd: 0.00042,
  totalTests: result.totalTests ?? 0,
  passed:     result.passed     ?? 0,
  failed:     result.failed     ?? 0,
  skipped:    result.skipped    ?? 0,
  status:     result.status     ?? 'ok',
  warnings:   result.warnings   ?? [],
  failures:   (result.failures  ?? []).map((f) => ({
    testId:              f.testId ?? f.title ?? 'unknown',
    title:               f.title  ?? f.testId ?? 'Unknown test',
    stack:               f.stack,
    durationMs:          f.durationMs,
    suggestedFixRegion:  f.suggestedFixRegion,
    suggestedPatch:      f.suggestedPatch,
    screenshotBase64:    f.screenshotBase64,
    domSnapshot:         f.domSnapshot,
  })),
};

// ── Render ─────────────────────────────────────────────────────────────────
const html = renderHtmlReport(input);
writeFileSync(OUTPUT_HTML, html, 'utf-8');

const byteSize = Buffer.byteLength(html, 'utf-8');
console.log(`[demo] Written: ${OUTPUT_HTML}`);
console.log(`[demo] Size:    ${byteSize.toLocaleString()} bytes`);
console.log(`Open: file:///${OUTPUT_HTML.replace(/\\/g, '/')}`);

// ── Fallback (no dist) ─────────────────────────────────────────────────────
function buildFallbackHtml(inp) {
  const esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return `<!DOCTYPE html><html><head><title>tspr Report — ${esc(inp.projectName)}</title></head>
<body style="font-family:sans-serif;padding:24px">
<h1>${esc(inp.projectName)}</h1>
<p>Status: <strong>${esc(inp.status)}</strong></p>
<p>Total: ${inp.totalTests} | Passed: ${inp.passed} | Failed: ${inp.failed} | Skipped: ${inp.skipped}</p>
<p><em>Note: built without dist. Run npm run build for the full report.</em></p>
${inp.failures.length ? `<h2>Failures</h2><ul>${inp.failures.map(f=>`<li><strong>${esc(f.title)}</strong><pre>${esc(f.stack??'')}</pre></li>`).join('')}</ul>` : ''}
</body></html>`;
}
