#!/usr/bin/env node
/**
 * M2 — tool 6 (generate_code_and_execute) dogfood against meme-weather.
 * The hero tool: cc writes test code → Docker sandbox runs it → results back.
 *
 * Prereqs: tspr/sandbox-node:24 image built; meme-weather dev server running on :3000
 *          (the test code may hit live endpoints); MINIMAX_API_KEY set.
 */
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tsprRoot  = resolve(__dirname, '..');
const cliPath   = resolve(tsprRoot, 'dist/cli/index.js');
const targetApp = 'D:/lll/meme-weather';
const keyPath   = resolve(tsprRoot, '.cairn-poc3-keys/mmmkey.txt');

const key = readFileSync(keyPath, 'utf-8').trim();

function log(s, m) { process.stdout.write(`[t6mw] ${s.padEnd(34)} ${m}\n`); }
function fail(s, m) { process.stderr.write(`[t6mw] FAIL ${s}: ${m}\n`); process.exit(1); }

if (!existsSync(cliPath)) fail('precheck', 'dist/cli/index.js missing');

log('precheck', `target = ${targetApp}`);

const server = spawn(process.execPath, [cliPath, 'mcp'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, MINIMAX_API_KEY: key },
});
let stderrBuf = '';
server.stderr.on('data', (c) => { stderrBuf += c.toString(); });

let buffer = '';
const pending = new Map();
let id = 0;

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

function send(method, params, t = 60_000) {
  const i = ++id;
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n');
  return new Promise((resolve, reject) => {
    pending.set(i, { resolve, reject });
    setTimeout(() => { if (pending.has(i)) { pending.delete(i); reject(new Error(`timeout ${method}#${i}`)); } }, t);
  });
}

async function callTool(name, args, t = 120_000) {
  const t0 = Date.now();
  log(name, 'calling...');
  try {
    const r = await send('tools/call', { name, arguments: args }, t);
    const txt = r?.content?.[0]?.text ?? JSON.stringify(r);
    log(name, `✅ ${Date.now() - t0}ms / ${txt.length}B`);
    return { ok: true, txt };
  } catch (err) {
    log(name, `❌ ${Date.now() - t0}ms: ${err.message ?? JSON.stringify(err).slice(0, 300)}`);
    return { ok: false, err };
  }
}

function listDir(p) {
  if (!existsSync(p)) return [];
  return readdirSync(p, { withFileTypes: true })
    .map((d) => ({ name: d.name, isDir: d.isDirectory(), size: d.isFile() ? statSync(join(p, d.name)).size : null }));
}

try {
  await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't6mw', version: '0.0.0' } });
  log('init', 'OK');

  // Bootstrap (needed for session)
  const boot = await callTool('tspr_bootstrap_tests',
    { localPort: 3003, type: 'backend', projectPath: targetApp, testScope: 'codebase' }, 30_000);
  if (!boot.ok) fail('bootstrap', 'cannot proceed');

  // The hero. Wide timeout — code gen + Docker exec is the slowest path.
  // Empty testIds = let tspr pick scenarios from prior backend_test_plan.
  const exec = await callTool('tspr_generate_code_and_execute', {
    projectName: 'meme-weather',
    projectPath: targetApp,
    testIds: [],
    additionalInstruction:
      'Generate vitest integration tests for the Next.js App Router API routes. ' +
      'Focus on /api/memes (GET/POST), /api/memes/[id]/bet (POST), /api/radar (GET), ' +
      '/api/settle/[week] (GET), and /api/graveyard (GET). Keep total cases ≤ 8 to fit ' +
      'in a short run. Use supertest pattern against a started Next server, or test ' +
      'route handlers directly via dynamic import if simpler.',
  }, 600_000);  // 10 min wall clock

  if (exec.ok) {
    log('exec-preview', exec.txt.slice(0, 500).replace(/\n/g, '\n  '));
  }

  // Inspect what landed in target's .tspr/ and tests/
  log('artifacts', '── inspecting outputs ──');
  for (const dir of ['.tspr', 'tests']) {
    const p = join(targetApp, dir);
    if (existsSync(p)) {
      const entries = listDir(p);
      log(`  ${dir}/`, entries.map((e) => `${e.name}${e.isDir ? '/' : ''}${e.size != null ? ' (' + e.size + 'B)' : ''}`).join(', ') || '(empty)');
    }
  }
  for (const sub of ['tests/tspr-generated', '.tspr/runs']) {
    const p = join(targetApp, sub);
    if (existsSync(p)) {
      const entries = listDir(p);
      log(`  ${sub}/`, entries.map((e) => `${e.name}${e.isDir ? '/' : ''}`).join(', ') || '(empty)');
    }
  }

  server.stdin.end();
  await new Promise((r) => { const t = setTimeout(() => { server.kill('SIGKILL'); r(); }, 5000); server.on('exit', () => { clearTimeout(t); r(); }); });

  process.stdout.write(`\n[t6mw] ${exec.ok ? '✅ TOOL 6 ON MEME-WEATHER GREEN' : '❌ TOOL 6 FAILED'}\n`);
  if (!exec.ok && stderrBuf) process.stderr.write(`\n[t6mw] server stderr (last 3KB):\n${stderrBuf.slice(-3000)}\n`);
  process.exit(exec.ok ? 0 : 1);
} catch (err) {
  if (stderrBuf) process.stderr.write(`\n[t6mw] server stderr (last 3KB):\n${stderrBuf.slice(-3000)}\n`);
  fail('main', err.message ?? String(err));
}
