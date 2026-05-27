#!/usr/bin/env node
/**
 * scripts/copy-dashboard-ui.mjs
 *
 * Post-build step: copies src/dashboard/ui/ → dist/dashboard/ui/
 * so the compiled server can read HTML/CSS/JS assets at runtime.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const srcUi = path.join(root, 'src', 'dashboard', 'ui');
const dstUi = path.join(root, 'dist', 'dashboard', 'ui');

fs.mkdirSync(dstUi, { recursive: true });

for (const file of fs.readdirSync(srcUi)) {
  const src = path.join(srcUi, file);
  const dst = path.join(dstUi, file);
  fs.copyFileSync(src, dst);
  process.stdout.write(`  copied ${file} → dist/dashboard/ui/${file}\n`);
}

process.stdout.write('[copy-dashboard-ui] done\n');
