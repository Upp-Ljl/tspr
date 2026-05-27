#!/usr/bin/env node
/**
 * Dogfood tspr_generate_code_and_execute — the hero tool that has never been
 * end-to-end smoked. Runs cc → generates test code → executes inside Docker
 * sandbox → reports results.
 *
 * Cost estimate: $0.10-$0.30 MiniMax tokens + 1 sandbox container lifecycle.
 */
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const cliPath  = resolve(repoRoot, 'dist/cli/index.js');
const demoApp  = resolve(repoRoot, 'fixtures/demo-app');
const keyPath  = resolve(repoRoot, '.cairn-poc3-keys/mmmkey.txt');

const key = readFileSync(keyPath, 'utf-8').trim();

function log(step, msg)  { process.stdout.write(`[t6] ${step.padEnd(24)} ${msg}\n`); }
function fail(step, msg) { process.stderr.write(`[t6] FAIL ${step}: ${msg}\n`); process.exit(1); }

if (!existsSync(cliPath)) fail('precheck', 'dist/cli/index.js missing — run npm run build');

log('precheck', 'spawning MCP server (provider=minimax)...');
const server = spawn(process.execPath, [cliPath, 'mcp'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env:   { ...process.env, MINIMAX_API_KEY: key },
});
let stderrBuf = '';
server.stderr.on('data', (c) => { stderrBuf += c.toString(); });

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

function send(method, params, timeoutMs = 60_000) {
  const id = ++idCounter;
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout ${method}#${id}`)); } }, timeoutMs);
  });
}

async function callTool(name, args, timeoutMs) {
  const t0 = Date.now();
  log(name, 'calling...');
  try {
    const r = await send('tools/call', { name, arguments: args }, timeoutMs);
    const text = r?.content?.[0]?.text ?? JSON.stringify(r);
    log(name, `✅ ${Date.now() - t0}ms, ${text.length}B`);
    return { ok: true, text };
  } catch (err) {
    log(name, `❌ ${Date.now() - t0}ms: ${err.message ?? JSON.stringify(err).slice(0, 200)}`);
    return { ok: false, err };
  }
}

try {
  await send('initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't6', version: '0.0.0' },
  });
  log('init', 'OK');

  // Bootstrap first (sets up session, checks Docker)
  const boot = await callTool('tspr_bootstrap_tests',
    { localPort: 5174, type: 'backend', projectPath: demoApp, testScope: 'codebase' }, 30_000);
  if (!boot.ok) fail('bootstrap', 'cannot proceed without bootstrap');

  // The hero call — give it 5 min wall clock (cc + Docker exec is slow)
  const exec = await callTool('tspr_generate_code_and_execute', {
    projectName:           'demo-app',
    projectPath:           demoApp,
    testIds:               [],
    additionalInstruction: 'Focus on the /api/todos PUT endpoint (the seeded 404 bug). Keep test suite under 5 cases.',
  }, 300_000);

  if (exec.ok) {
    log('result-preview', exec.text.slice(0, 600).replace(/\n/g, '\n  '));
  }

  server.stdin.end();
  await new Promise((r) => { const t = setTimeout(() => { server.kill('SIGKILL'); r(); }, 3000); server.on('exit', () => { clearTimeout(t); r(); }); });

  process.stdout.write(`\n[t6] ${exec.ok ? '✅ TOOL 6 DOGFOOD GREEN' : '❌ TOOL 6 FAILED'}\n`);
  process.exit(exec.ok ? 0 : 1);
} catch (err) {
  if (stderrBuf) process.stderr.write(`\n[t6] server stderr (last 2KB):\n${stderrBuf.slice(-2000)}\n`);
  fail('main', err.message ?? String(err));
}
