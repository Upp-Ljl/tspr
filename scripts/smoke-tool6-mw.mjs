#!/usr/bin/env node
/**
 * Dry-run probe: Tool 6 against meme-weather.
 *
 * Does NOT invoke cc to regenerate tests — reuses the existing generated spec
 * at D:/lll/meme-weather/.tspr/generated_tests/meme-weather.spec.ts.
 * Spins up a real Docker sandbox, runs vitest from /tspr-runtime, and
 * asserts totalTests > 0 (meaning vitest actually executed — independent of
 * whether the meme-weather app is running).
 *
 * Prerequisites:
 *   - docker + tspr/sandbox-node:24 image present
 *   - npm run build already done in this worktree
 *
 * Run: node scripts/smoke-tool6-mw.mjs
 * Exit 0 = totalTests > 0, non-zero = vitest didn't run.
 */
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const distRoot = resolve(repoRoot, 'dist');

// ── Verify prereqs ────────────────────────────────────────────────────────────
const cliEntry = resolve(distRoot, 'tools/generateAndExecute.js');
if (!fs.existsSync(cliEntry)) {
  console.error('[smoke-tool6-mw] ERROR: dist/tools/generateAndExecute.js missing — run npm run build first');
  process.exit(1);
}

try {
  execSync('docker info', { stdio: 'pipe', timeout: 5000 });
  execSync('docker image inspect tspr/sandbox-node:24', { stdio: 'pipe', timeout: 5000 });
} catch {
  console.error('[smoke-tool6-mw] ERROR: Docker or tspr/sandbox-node:24 not available');
  process.exit(1);
}

const MW_PATH = resolve('D:/lll/meme-weather');
if (!fs.existsSync(MW_PATH)) {
  console.error(`[smoke-tool6-mw] ERROR: meme-weather not found at ${MW_PATH}`);
  process.exit(1);
}

const generatedSpec = resolve(MW_PATH, '.tspr/generated_tests/meme-weather.spec.ts');
if (!fs.existsSync(generatedSpec)) {
  console.error(`[smoke-tool6-mw] ERROR: generated spec missing at ${generatedSpec}`);
  process.exit(1);
}

// ── Build a minimal mock ServerContext ────────────────────────────────────────
const { runExecute } = await import(pathToFileURL(cliEntry).href);

// We need a mock db, logger, config, ccClient
const mockDb = {
  prepare: () => ({ run: () => ({ lastInsertRowid: 0 }) }),
};
const mockLogger = {
  info: (...a) => console.log('[sandbox]', ...a),
  warn: (...a) => console.warn('[sandbox warn]', ...a),
  error: (...a) => console.error('[sandbox error]', ...a),
  debug: () => {},
};
const mockConfig = {
  dockerImage: 'tspr/sandbox-node:24',
  executeTimeoutMs: 300_000,
};

// cc client returns the existing generated spec verbatim (avoids re-generating)
const existingSpec = fs.readFileSync(generatedSpec, 'utf-8');
const mockCcClient = {
  run: async () => ({ stdout: existingSpec, stderr: '', exitCode: 0 }),
};

const ctx = {
  db: mockDb,
  logger: mockLogger,
  config: mockConfig,
  ccClient: mockCcClient,
};

// ── Run ───────────────────────────────────────────────────────────────────────
console.log('[smoke-tool6-mw] Starting dry-run against meme-weather...');
console.log(`[smoke-tool6-mw] Project: ${MW_PATH}`);
console.log('[smoke-tool6-mw] (meme-weather app does NOT need to be running — just proving vitest executed)');

const t0 = Date.now();
let result;
try {
  result = await runExecute(
    {
      projectName: 'meme-weather',
      projectPath: MW_PATH,
      testIds: [],
      additionalInstruction: '',
    },
    ctx,
    // No sandbox mock — uses production createSandbox path
  );
} catch (err) {
  console.error('[smoke-tool6-mw] runExecute threw:', err);
  process.exit(1);
}

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n[smoke-tool6-mw] Done in ${elapsed}s`);
console.log(`[smoke-tool6-mw] totalTests : ${result.totalTests}`);
console.log(`[smoke-tool6-mw] passed     : ${result.passed}`);
console.log(`[smoke-tool6-mw] failed     : ${result.failed}`);
console.log(`[smoke-tool6-mw] status     : ${result.status}`);

if (result.totalTests === 0) {
  console.error('[smoke-tool6-mw] FAIL: totalTests=0 — vitest did not run (same bug as before)');
  process.exit(1);
}

console.log('[smoke-tool6-mw] PASS: vitest executed and returned test counts');
process.exit(0);
