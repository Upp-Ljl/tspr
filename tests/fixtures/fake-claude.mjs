#!/usr/bin/env node
/**
 * Fake `claude` CLI for testing.
 *
 * Behaviour is controlled by environment variables:
 *   FAKE_CLAUDE_EXIT_CODE    — process exit code (default: 0)
 *   FAKE_CLAUDE_STDOUT       — text written to stdout (default: '{"ok":true}')
 *   FAKE_CLAUDE_STDERR       — text written to stderr (default: '')
 *   FAKE_CLAUDE_DELAY_MS     — delay before exiting in ms (default: 0)
 */

const exitCode = parseInt(process.env['FAKE_CLAUDE_EXIT_CODE'] ?? '0', 10);
const stdout   = process.env['FAKE_CLAUDE_STDOUT'] ?? '{"ok":true}';
const stderr   = process.env['FAKE_CLAUDE_STDERR'] ?? '';
const delayMs  = parseInt(process.env['FAKE_CLAUDE_DELAY_MS'] ?? '0', 10);

function run() {
  if (stderr) process.stderr.write(stderr + '\n');
  if (stdout) process.stdout.write(stdout);
  process.exit(exitCode);
}

if (delayMs > 0) {
  setTimeout(run, delayMs);
} else {
  run();
}
