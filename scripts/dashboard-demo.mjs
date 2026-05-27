#!/usr/bin/env node
/**
 * scripts/dashboard-demo.mjs
 *
 * Proves the dashboard boots and serves without hand-rolling.
 * Starts on port 7654 (or env PORT), waits 5 s, then closes cleanly.
 *
 * Usage:  node scripts/dashboard-demo.mjs
 *         PORT=8080 node scripts/dashboard-demo.mjs
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

// Resolve the compiled dashboard server from dist/
// When run after `npm run build` it lives at dist/dashboard/server.js

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distServerPath = path.join(__dirname, '..', 'dist', 'dashboard', 'server.js');
// On Windows, dynamic import() requires a file:// URL for absolute paths
const distServerUrl = pathToFileURL(distServerPath).href;

let startDashboard;
try {
  const mod = await import(distServerUrl);
  startDashboard = mod.startDashboard;
} catch (err) {
  process.stderr.write(
    `[dashboard-demo] Could not load ${distServerPath}\n` +
    `  Run "npm run build" first, then re-run this script.\n` +
    `  Error: ${err.message}\n`,
  );
  process.exit(1);
}

const port = parseInt(process.env.PORT ?? '7654', 10);

process.stdout.write(`[dashboard-demo] starting on port ${port}…\n`);

let handle;
try {
  handle = await startDashboard({ port, open: false });
} catch (err) {
  process.stderr.write(`[dashboard-demo] failed to start: ${err.message}\n`);
  process.exit(1);
}

process.stdout.write(`[dashboard-demo] listening at ${handle.url}\n`);
process.stdout.write(`[dashboard-demo] waiting 5 s…\n`);

await new Promise((resolve) => setTimeout(resolve, 5000));

process.stdout.write(`[dashboard-demo] closing…\n`);
await handle.close();
process.stdout.write(`[dashboard-demo] closed cleanly ✓\n`);
