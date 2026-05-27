#!/usr/bin/env node
/**
 * Tspr dogfood against meme-weather (the real Next.js + Supabase fixture).
 * Runs the planning chain (tools 2-5, no Docker exec yet).
 *
 * Reports each tool: duration, output size, first ~250 chars, artifact path.
 */
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tsprRoot  = resolve(__dirname, '..');
const cliPath   = resolve(tsprRoot, 'dist/cli/index.js');
const targetApp = 'D:/lll/meme-weather';
const keyPath   = resolve(tsprRoot, '.cairn-poc3-keys/mmmkey.txt');

const key = readFileSync(keyPath, 'utf-8').trim();

function log(s, m) { process.stdout.write(`[mw] ${s.padEnd(34)} ${m}\n`); }
function fail(s, m) { process.stderr.write(`[mw] FAIL ${s}: ${m}\n`); process.exit(1); }

if (!existsSync(cliPath)) fail('precheck', 'dist/cli/index.js missing');
if (!existsSync(targetApp)) fail('precheck', `${targetApp} missing`);

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
    const preview = txt.slice(0, 250).replace(/\n/g, ' ').trim();
    log(name, `✅ ${Date.now() - t0}ms / ${txt.length}B  "${preview}${txt.length > 250 ? '…' : ''}"`);
    return { ok: true, txt };
  } catch (err) {
    log(name, `❌ ${Date.now() - t0}ms: ${err.message ?? JSON.stringify(err).slice(0, 200)}`);
    return { ok: false, err };
  }
}

function reportArtifact(label, p) {
  if (existsSync(p)) { const s = statSync(p); log(label, `📄 ${p} (${s.size}B)`); }
  else log(label, `(no artifact at ${p})`);
}

try {
  await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mw', version: '0.0.0' } });
  log('init', 'OK');

  await callTool('tspr_bootstrap_tests',
    { localPort: 3000, type: 'backend', projectPath: targetApp, testScope: 'codebase' }, 30_000);

  await callTool('tspr_generate_code_summary', { projectRootPath: targetApp }, 180_000);
  reportArtifact('summary', join(targetApp, '.tspr', 'code_summary.json'));

  await callTool('tspr_generate_standardized_prd', { projectPath: targetApp }, 180_000);
  reportArtifact('prd', join(targetApp, '.tspr', 'standard_prd.json'));

  await callTool('tspr_generate_backend_test_plan', { projectPath: targetApp }, 180_000);
  reportArtifact('backend-plan', join(targetApp, '.tspr', 'backend_test_plan.json'));

  await callTool('tspr_generate_frontend_test_plan', { projectPath: targetApp, needLogin: true }, 180_000);
  reportArtifact('frontend-plan', join(targetApp, '.tspr', 'frontend_test_plan.json'));

  server.stdin.end();
  await new Promise((r) => { const t = setTimeout(() => { server.kill('SIGKILL'); r(); }, 3000); server.on('exit', () => { clearTimeout(t); r(); }); });

  process.stdout.write(`\n[mw] ✅ TSPR PLANNING CHAIN AGAINST MEME-WEATHER COMPLETE\n`);
} catch (err) {
  if (stderrBuf) process.stderr.write(`\n[mw] server stderr (last 2KB):\n${stderrBuf.slice(-2000)}\n`);
  fail('main', err.message ?? String(err));
}
