#!/usr/bin/env node
/**
 * Real end-to-end dogfood: MCP server + real MiniMax cc + demo fixture.
 *
 * Runs the planning chain (no Docker exec yet):
 *   1. bootstrap_tests
 *   2. generate_code_summary
 *   3. generate_standardized_prd
 *   4. generate_backend_test_plan
 *
 * For each tool: report duration, output size, first 200 chars of result,
 * and (where applicable) the artifact file landed under fixtures/demo-app/.tspr/.
 *
 * Cost guard: a typical run costs a few cents on M2.7-highspeed.
 * Hard-aborts if any single tool call exceeds 60s.
 */
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const cliPath = resolve(repoRoot, 'dist/cli/index.js');
const demoApp = resolve(repoRoot, 'fixtures/demo-app');
const keyPath = resolve(repoRoot, '.cairn-poc3-keys/mmmkey.txt');

const key = readFileSync(keyPath, 'utf-8').trim();

function log(step, msg) { process.stdout.write(`[real] ${step.padEnd(28)} ${msg}\n`); }
function fail(step, msg) { process.stderr.write(`[real] FAIL ${step}: ${msg}\n`); process.exit(1); }

if (!existsSync(cliPath)) fail('precheck', `dist/cli/index.js missing — run npm run build`);
if (!existsSync(demoApp)) fail('precheck', `fixtures/demo-app missing`);

log('precheck', 'spawning MCP server (provider=minimax)...');
const server = spawn(process.execPath, [cliPath, 'mcp'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, MINIMAX_API_KEY: key },
});

let stderrBuf = '';
server.stderr.on('data', (chunk) => { stderrBuf += chunk.toString(); });

let buffer = '';
const pending = new Map();
let idCounter = 0;

server.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve: r, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(msg.error); else r(msg.result);
    }
  }
});

function send(method, params, timeoutMs = 90_000) {
  const id = ++idCounter;
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout ${method}#${id}`)); }
    }, timeoutMs);
  });
}

async function callTool(name, args, timeoutMs = 90_000) {
  const t0 = Date.now();
  log(name, 'calling...');
  let result;
  try {
    result = await send('tools/call', { name, arguments: args }, timeoutMs);
  } catch (err) {
    const dt = Date.now() - t0;
    log(name, `❌ FAIL after ${dt}ms: ${err.message ?? JSON.stringify(err).slice(0, 200)}`);
    return null;
  }
  const dt = Date.now() - t0;
  const text = result?.content?.[0]?.text ?? JSON.stringify(result);
  const preview = text.slice(0, 200).replace(/\n/g, ' ').trim();
  log(name, `✅ ${dt}ms, ${text.length}B  preview="${preview}${text.length > 200 ? '...' : ''}"`);
  return result;
}

function reportArtifact(label, path) {
  if (existsSync(path)) {
    const s = statSync(path);
    log(label, `📄 ${path} (${s.size}B)`);
  } else {
    log(label, `(no artifact at ${path})`);
  }
}

try {
  log('1-init', 'sending initialize...');
  await send('initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'real', version: '0.0.0' },
  });
  log('1-init', 'OK');

  await callTool('tspr_bootstrap_tests', {
    localPort: 5174, type: 'backend', projectPath: demoApp, testScope: 'codebase',
  }, 30_000);

  await callTool('tspr_generate_code_summary', {
    projectRootPath: demoApp,
  }, 120_000);
  reportArtifact('summary-artifact', join(demoApp, '.tspr', 'code_summary.json'));

  await callTool('tspr_generate_standardized_prd', {
    projectPath: demoApp,
  }, 120_000);
  reportArtifact('prd-artifact', join(demoApp, '.tspr', 'standard_prd.json'));

  await callTool('tspr_generate_backend_test_plan', {
    projectPath: demoApp,
  }, 120_000);
  reportArtifact('backend-plan', join(demoApp, '.tspr', 'backend_test_plan.json'));

  log('teardown', 'closing server...');
  server.stdin.end();
  await new Promise((r) => { const t = setTimeout(() => { server.kill('SIGKILL'); r(); }, 3000); server.on('exit', () => { clearTimeout(t); r(); }); });
  log('teardown', 'OK');

  process.stdout.write(`\n[real] ✅ PIPELINE DOGFOOD COMPLETE\n`);
} catch (err) {
  if (stderrBuf) process.stderr.write(`\n[real] server stderr:\n${stderrBuf.slice(-2000)}\n`);
  fail('main', err.message ?? String(err));
}
