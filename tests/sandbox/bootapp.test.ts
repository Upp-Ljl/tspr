/**
 * bootApp tests: B-2-9, B-2-10, B-2-11
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import { createSandbox, SandboxError } from '../../src/sandbox/index.js';
import { makeTempProject, makeProjectWithServerScript, makeProjectWithHttpServer, cleanupLeakedContainers } from './helpers.js';

let dockerAvailable = true;

beforeAll(async () => {
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 5000 });
    execSync('docker image inspect localsprite/sandbox-node:24', { stdio: 'pipe', timeout: 5000 });
  } catch {
    dockerAvailable = false;
    console.warn('[bootapp.test] Docker or sandbox image not available — skipping');
  }
});

afterAll(async () => {
  await cleanupLeakedContainers();
});

describe('bootApp', () => {
  it('BOOTAPP-TCP-PROBE-WAIT: resolves when TCP server is ready (B-2-9)', async () => {
    if (!dockerAvailable) return;
    const projectPath = await makeTempProject({
      'server.js': `
const net = require('net');
const p = parseInt(process.env.PORT, 10);
const server = net.createServer((s) => { s.pipe(s); });
server.listen(p, '0.0.0.0', () => {
  process.stdout.write('TCP server listening on port ' + p + String.fromCharCode(10));
});
server.on('error', (e) => { process.stderr.write(e.message + String.fromCharCode(10)); process.exit(1); });
`,
    });
    const handle = await createSandbox({ projectPath, projectType: 'backend' });

    try {
      const appHandle = await handle.bootApp(
        `node /work/server.js`,
        {
          port: handle.port,
          readyProbe: { type: 'tcp', port: handle.port },
          startupTimeoutMs: 20_000,
          env: { PORT: String(handle.port) },
        }
      );

      expect(appHandle).toBeDefined();
      expect(typeof appHandle.pid).toBe('number');
      expect(appHandle.pid).toBeGreaterThanOrEqual(0);

      await appHandle.kill();
    } finally {
      await handle.dispose();
    }
  }, { timeout: 60_000 });

  it('BOOTAPP-TCP-TIMEOUT: throws ERR_CONTAINER_START_TIMEOUT when nothing listens (B-2-9)', async () => {
    if (!dockerAvailable) return;
    const handle = await createSandbox({
      projectPath: await makeTempProject(),
      projectType: 'backend',
    });

    try {
      await expect(
        handle.bootApp('sleep 300', {
          port: handle.port,
          readyProbe: { type: 'tcp', port: handle.port },
          startupTimeoutMs: 2_000,
        })
      ).rejects.toMatchObject({ code: 'ERR_CONTAINER_START_TIMEOUT' });
    } finally {
      await handle.dispose();
    }
  }, { timeout: 30_000 });

  it('BOOTAPP-HTTP-PROBE: resolves when HTTP server responds 200 (B-2-10)', async () => {
    if (!dockerAvailable) return;
    const projectPath = await makeTempProject({
      'http-server.js': `
const http = require('http');
const p = parseInt(process.env.PORT, 10);
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('OK\\n');
});
server.listen(p, '0.0.0.0', () => {
  process.stdout.write('HTTP server listening on port ' + p + '\\n');
});
server.on('error', (e) => { process.stderr.write(e.message + String.fromCharCode(10)); process.exit(1); });
`,
    });
    const handle = await createSandbox({ projectPath, projectType: 'backend' });

    try {
      // Per B-2-27: same port on host and container sides
      const appHandle = await handle.bootApp('node /work/http-server.js', {
        readyProbe: {
          type: 'http',
          url: `http://localhost:${handle.port}/`,
          expectedStatus: 200,
        },
        startupTimeoutMs: 20_000,
        env: { PORT: String(handle.port) },
      });

      expect(appHandle).toBeDefined();
      expect(appHandle.pid).toBeGreaterThanOrEqual(0);

      await appHandle.kill();
    } finally {
      await handle.dispose();
    }
  }, { timeout: 60_000 });

  it('BOOTAPP-HTTP-PROBE-CUSTOM-STATUS: resolves on custom expectedStatus 204 (B-2-10)', async () => {
    if (!dockerAvailable) return;
    const projectPath = await makeTempProject({
      'http-204.js': `
const http = require('http');
const p = parseInt(process.env.PORT, 10);
const server = http.createServer((req, res) => {
  res.writeHead(204);
  res.end();
});
server.listen(p, '0.0.0.0', () => {
  process.stdout.write('HTTP 204 server listening on port ' + p + '\\n');
});
server.on('error', (e) => { process.stderr.write(e.message + String.fromCharCode(10)); process.exit(1); });
`,
    });
    const handle = await createSandbox({ projectPath, projectType: 'backend' });

    try {
      const appHandle = await handle.bootApp('node /work/http-204.js', {
        readyProbe: {
          type: 'http',
          url: `http://localhost:${handle.port}/`,
          expectedStatus: 204,
        },
        startupTimeoutMs: 20_000,
        env: { PORT: String(handle.port) },
      });

      expect(appHandle).toBeDefined();
      await appHandle.kill();
    } finally {
      await handle.dispose();
    }
  }, { timeout: 60_000 });

  it('BOOTAPP-STDOUT-PROBE: resolves when stdout matches pattern (B-2-11)', async () => {
    if (!dockerAvailable) return;
    const handle = await createSandbox({
      projectPath: await makeTempProject(),
      projectType: 'backend',
    });

    try {
      const appHandle = await handle.bootApp(
        'node -e "setTimeout(() => { process.stdout.write(\'Server ready\\n\'); }, 1000); setInterval(() => {}, 1000);"',
        {
          readyProbe: { type: 'stdout', pattern: /ready/ },
          startupTimeoutMs: 15_000,
        }
      );

      expect(appHandle).toBeDefined();
      expect(appHandle.pid).toBeGreaterThanOrEqual(0);
      await appHandle.kill();
    } finally {
      await handle.dispose();
    }
  }, { timeout: 60_000 });

  it('BOOTAPP-APP-HANDLE-KILL: kill() resolves and waitForExit() gives number', async () => {
    if (!dockerAvailable) return;
    const projectPath = await makeTempProject({
      'server.js': `
const net = require('net');
const p = parseInt(process.env.PORT, 10);
const server = net.createServer((s) => { s.pipe(s); });
server.listen(p, '0.0.0.0', () => {
  process.stdout.write('TCP server listening on port ' + p + String.fromCharCode(10));
});
`,
    });
    const handle = await createSandbox({ projectPath, projectType: 'backend' });

    try {
      const appHandle = await handle.bootApp('node /work/server.js', {
        port: handle.port,
        readyProbe: { type: 'tcp', port: handle.port },
        startupTimeoutMs: 20_000,
        env: { PORT: String(handle.port) },
      });

      await appHandle.kill();
      const exitCode = await appHandle.waitForExit();
      expect(typeof exitCode).toBe('number');
    } finally {
      await handle.dispose();
    }
  }, { timeout: 60_000 });

  it('BOOTAPP-KILL-IDEMPOTENT: kill() called twice does not throw', async () => {
    if (!dockerAvailable) return;
    const projectPath = await makeTempProject({
      'server.js': `
const net = require('net');
const p = parseInt(process.env.PORT, 10);
const server = net.createServer((s) => { s.pipe(s); });
server.listen(p, '0.0.0.0', () => {
  process.stdout.write('TCP server ready on port ' + p + '\\n');
});
`,
    });
    const handle = await createSandbox({ projectPath, projectType: 'backend' });

    try {
      const appHandle = await handle.bootApp('node /work/server.js', {
        port: handle.port,
        readyProbe: { type: 'tcp', port: handle.port },
        startupTimeoutMs: 20_000,
        env: { PORT: String(handle.port) },
      });

      await appHandle.kill();
      await appHandle.kill(); // second call — must not throw
    } finally {
      await handle.dispose();
    }
  }, { timeout: 60_000 });
});
