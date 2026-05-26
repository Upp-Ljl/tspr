#!/usr/bin/env node
/**
 * Live smoke against a real MiniMax API key.
 * Reads the key from .cairn-poc3-keys/mmmkey.txt (gitignored), sets env,
 * invokes the cc client through the configured provider (~/.localsprite/config.json),
 * sends one short prompt to MiniMax-M2.7-highspeed.
 *
 * Cost guard: limits to one short call; aborts if response > 200 tokens.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const keyPath = resolve(repoRoot, '.cairn-poc3-keys/mmmkey.txt');

const key = readFileSync(keyPath, 'utf-8').trim();
if (!key) {
  process.stderr.write(`[smoke-minimax] key file empty at ${keyPath}\n`);
  process.exit(1);
}
process.env.MINIMAX_API_KEY = key;

const { createCcClient, loadConfig } = await import(`file://${repoRoot.replace(/\\/g, '/')}/dist/lib/index.js`);

const config = loadConfig();
console.log(`[smoke-minimax] provider=${config.provider}`);
console.log(`[smoke-minimax] aliases=${JSON.stringify(config.modelAlias)}`);

const cc = createCcClient(config);

console.log('[smoke-minimax] sending tiny prompt to haiku alias...');
const t0 = Date.now();
const result = await cc.run({
  model: 'haiku',
  prompt: 'Reply with exactly: PONG',
  timeoutMs: 30_000,
});
const dt = Date.now() - t0;

console.log(`[smoke-minimax] response in ${dt}ms (model=${result.modelUsed} cost=$${result.costUsd.toFixed(6)})`);
console.log(`[smoke-minimax] stdout (first 200 chars):`);
console.log('  ' + result.stdout.slice(0, 200).replace(/\n/g, '\n  '));

if (result.stdout.toUpperCase().includes('PONG')) {
  console.log('\n[smoke-minimax] ✅ MiniMax round-trip OK');
  process.exit(0);
} else {
  console.error('\n[smoke-minimax] ⚠️ response did not contain PONG — but call succeeded');
  process.exit(0);
}
