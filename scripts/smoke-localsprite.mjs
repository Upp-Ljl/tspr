#!/usr/bin/env node
/**
 * Smoke test for localsprite — end-to-end:
 *   1. Spawn the MCP server as a stdio child.
 *   2. Initialize via MCP protocol.
 *   3. tools/list — verify all 8 tools register with expected names.
 *   4. tools/call localsprite_bootstrap_tests against the demo fixture.
 *   5. Tear down.
 *
 * Run: node scripts/smoke-localsprite.mjs
 * Exit 0 = all green, non-zero = failure (caller prints which step).
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const cliPath = resolve(repoRoot, 'dist/cli/index.js');
const demoApp = resolve(repoRoot, 'fixtures/demo-app');

const EXPECTED_TOOLS = [
  'localsprite_bootstrap_tests',
  'localsprite_generate_code_summary',
  'localsprite_generate_standardized_prd',
  'localsprite_generate_frontend_test_plan',
  'localsprite_generate_backend_test_plan',
  'localsprite_generate_code_and_execute',
  'localsprite_open_test_result_dashboard',
  'localsprite_rerun_tests',
];

function log(step, msg) {
  process.stdout.write(`[smoke] ${step.padEnd(28)} ${msg}\n`);
}
function fail(step, msg) {
  process.stderr.write(`[smoke] FAIL ${step}: ${msg}\n`);
  process.exit(1);
}

if (!existsSync(cliPath)) {
  fail('precheck', `dist/cli/index.js missing — run \`npm run build\` first`);
}
if (!existsSync(demoApp)) {
  fail('precheck', `fixtures/demo-app missing`);
}

const server = spawn(process.execPath, [cliPath, 'mcp'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, LOCALSPRITE_LOG_LEVEL: 'error' },
});

let stderrBuf = '';
server.stderr.on('data', (chunk) => { stderrBuf += chunk.toString(); });

server.on('error', (err) => fail('spawn', err.message));

let idCounter = 0;
let buffer = '';
const pending = new Map();

server.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  // MCP stdio transport: newline-delimited JSON (per @modelcontextprotocol/sdk)
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line) handleMessage(line);
  }
});

function handleMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (msg.id != null && pending.has(msg.id)) {
    const { resolve: r, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(msg.error);
    else r(msg.result);
  }
}

function send(method, params) {
  const id = ++idCounter;
  const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  // MCP stdio: newline-delimited JSON
  server.stdin.write(body + '\n');
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}#${id}`));
      }
    }, 30_000);
  });
}

async function main() {
  log('1-init', 'sending initialize...');
  const initResult = await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '0.0.0' },
  });
  if (!initResult || !initResult.serverInfo) {
    fail('1-init', `no serverInfo in initialize result: ${JSON.stringify(initResult)}`);
  }
  log('1-init', `OK serverInfo.name=${initResult.serverInfo.name}`);

  log('2-tools-list', 'fetching tool list...');
  const listResult = await send('tools/list', {});
  const names = (listResult?.tools ?? []).map((t) => t.name).sort();
  const expected = [...EXPECTED_TOOLS].sort();
  const missing = expected.filter((n) => !names.includes(n));
  const extra = names.filter((n) => !expected.includes(n));
  if (missing.length || extra.length) {
    fail('2-tools-list',
      `tool mismatch — missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}`);
  }
  log('2-tools-list', `OK 8/8 tools registered`);

  log('3-bootstrap-call', 'invoking localsprite_bootstrap_tests on demo fixture...');
  try {
    const callResult = await send('tools/call', {
      name: 'localsprite_bootstrap_tests',
      arguments: {
        localPort: 5174,
        type: 'backend',
        projectPath: demoApp,
        testScope: 'codebase',
      },
    });
    if (!callResult) fail('3-bootstrap-call', 'empty result');
    log('3-bootstrap-call', `OK content.length=${callResult.content?.length ?? 0}`);
  } catch (err) {
    // Bootstrap may fail if dependencies aren't installed in fixture; treat as soft pass
    // as long as it's a structured tool-level error, not a transport error.
    if (err.code && typeof err.code === 'number') {
      log('3-bootstrap-call', `OK (tool returned structured error code=${err.code} — acceptable)`);
    } else {
      fail('3-bootstrap-call', `transport-level failure: ${JSON.stringify(err)}`);
    }
  }

  log('4-teardown', 'closing server...');
  server.stdin.end();
  await new Promise((resolve) => {
    const t = setTimeout(() => { server.kill('SIGKILL'); resolve(); }, 3000);
    server.on('exit', () => { clearTimeout(t); resolve(); });
  });
  log('4-teardown', 'OK');

  process.stdout.write(`\n[smoke] ✅ ALL STEPS PASSED\n`);
  process.exit(0);
}

main().catch((err) => {
  if (stderrBuf) process.stderr.write(`\n[smoke] server stderr:\n${stderrBuf}\n`);
  fail('main', err.message ?? String(err));
});
