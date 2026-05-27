/**
 * scripts/pr-comment-demo.mjs
 *
 * Demo: runs pr-comment subcommand with --dry-run against the
 * meme-weather fixture and prints the resulting markdown to stdout.
 *
 * Usage: node scripts/pr-comment-demo.mjs
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// Attempt to load dist; on Windows we must use file:// URLs for dynamic import.
let runPrCommentCommand;

try {
  const distPath = path.join(root, 'dist', 'cli', 'pr-comment-command.js');
  const mod = await import(pathToFileURL(distPath).href);
  runPrCommentCommand = mod.runPrCommentCommand;
} catch (e) {
  // dist not built yet — provide a pure-JS fallback using the formatter directly
  const formatterPath = path.join(root, 'dist', 'pr', 'format-comment.js');
  const formatterMod = await import(pathToFileURL(formatterPath).href);
  const { formatPrComment } = formatterMod;

  // Read fixture directly
  const fixtureFile = path.join('D:', 'lll', 'meme-weather', '.tspr', 'test_results.json');
  const results = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));

  const input = {
    runId: results.outputPath ?? 'meme-weather-latest',
    projectName: 'meme-weather',
    startedAt: new Date(),
    durationMs: 0,
    totalTests: results.totalTests ?? 0,
    passed: results.passed ?? 0,
    failed: results.failed ?? 0,
    skipped: results.skipped ?? 0,
    status: results.status ?? 'partial',
    failures: (results.failures ?? []).map((f) => ({
      testId: f.testId ?? '',
      title: f.title ?? f.testId ?? 'unknown',
      stack: f.stack,
      suggestedFixRegion: f.suggestedFixRegion,
      suggestedPatch: f.suggestedPatch,
    })),
    reportUrl: (() => {
      if (!results.reportPath) return undefined;
      const n = results.reportPath.replace(/\\/g, '/');
      return n.startsWith('/') ? `file://${n}` : `file:///${n}`;
    })(),
  };

  const md = formatPrComment(input);
  process.stdout.write(md + '\n');
  process.exit(0);
}

// Run via the full command
const exitCode = await runPrCommentCommand([
  '999',
  '--dry-run',
  '--projectPath',
  path.join('D:', 'lll', 'meme-weather'),
]);

if (exitCode === 0) {
  // The command writes to ~/.tspr/pr-comment-999.md and prints the path.
  // Read and print the markdown content.
  const outPath = path.join(os.homedir(), '.tspr', 'pr-comment-999.md');
  try {
    const md = fs.readFileSync(outPath, 'utf8');
    process.stdout.write(md + '\n');
  } catch {
    // path was already printed by the command
  }
}

process.exit(exitCode);
