/**
 * Signal cleanup tests: B-2-16, B-2-28
 * These tests spawn child processes and send SIGINT/SIGTERM.
 *
 * POSIX-only: on Windows, child_process.kill(signal) cannot deliver SIGINT/SIGTERM
 * gracefully — Node maps them to forceful termination, so user-space signal
 * handlers never fire. The cleanup contract (B-2-16, B-2-28) is verified on
 * Linux/macOS; on Windows, container cleanup falls back to TTL expiry +
 * beforeExit handler for graceful exits.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { listManagedContainers, cleanupLeakedContainers } from './helpers.js';

const isWindows = os.platform() === 'win32';
let dockerAvailable = true;

beforeAll(async () => {
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 5000 });
    execSync('docker image inspect localsprite/sandbox-node:24', { stdio: 'pipe', timeout: 5000 });
  } catch {
    dockerAvailable = false;
    console.warn('[sigint.test] Docker or sandbox image not available — skipping');
  }
});

afterAll(async () => {
  await cleanupLeakedContainers();
});

/**
 * Spawns a child Node.js process that:
 * 1. Creates a sandbox
 * 2. Writes its container ID to a temp file
 * 3. Idles for 60 seconds
 * Then we send a signal and check the container is cleaned up.
 */
async function spawnSandboxChild(signal: 'SIGINT' | 'SIGTERM'): Promise<void> {
  if (!dockerAvailable) return;

  // Use compiled dist output — child processes run under plain Node.js (no tsx/vitest transform)
  const worktreeRoot = path.join(import.meta.dirname, '..', '..');
  const distIndexPath = path.join(worktreeRoot, 'dist', 'sandbox', 'index.js');
  const containerIdFile = path.join(os.tmpdir(), `container-id-${Date.now()}.txt`);

  // Ensure dist is built
  if (!fs.existsSync(distIndexPath)) {
    const { execSync: exec } = await import('child_process');
    exec('npm run build', { cwd: worktreeRoot, stdio: 'pipe' });
  }

  // On Windows, ESM import needs file:// URL for absolute paths
  const distIndexUrl = new URL('file:///' + distIndexPath.replace(/\\/g, '/')).href;

  // Write child script using compiled dist
  const childScript = `
import { createSandbox } from '${distIndexUrl}';
import * as fs from 'fs';

async function main() {
  const handle = await createSandbox({
    projectPath: '${os.tmpdir().replace(/\\/g, '/')}',
    projectType: 'frontend',
    ttlMs: 60000,
  });
  fs.writeFileSync('${containerIdFile.replace(/\\/g, '/')}', handle.id);
  // Idle and wait for signal
  await new Promise(r => setTimeout(r, 60000));
}

main().catch(e => {
  console.error('child error:', e.message);
  process.exit(1);
});
`;

  const child = spawn(process.execPath, ['--input-type=module'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  child.stdin!.write(childScript);
  child.stdin!.end();

  // Wait for the container ID to be written (up to 30s)
  let containerId = '';
  const startWait = Date.now();
  while (Date.now() - startWait < 30_000) {
    if (fs.existsSync(containerIdFile)) {
      containerId = fs.readFileSync(containerIdFile, 'utf-8').trim();
      if (containerId.length > 0) break;
    }
    await new Promise<void>((r) => setTimeout(r, 500));
  }

  if (!containerId) {
    child.kill('SIGKILL');
    throw new Error(`Child process did not create a container within 30s`);
  }

  // Send the signal
  child.kill(signal);

  // Wait for child to exit
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 10_000);
    child.on('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });

  // Wait a moment for container removal
  await new Promise<void>((r) => setTimeout(r, 3_000));

  // Check container is gone
  try {
    execSync(`docker inspect ${containerId}`, { stdio: 'pipe', timeout: 5000 });
    // If no error, container still exists — fail
    throw new Error(`Container ${containerId} still exists after ${signal}`);
  } catch (err) {
    const e = err as { message?: string; status?: number };
    // docker inspect exits with non-zero when container doesn't exist
    // That's the expected outcome
    if (e.message?.includes('still exists')) {
      throw err;
    }
    // Container is gone —
  }

  // Cleanup
  try { fs.unlinkSync(containerIdFile); } catch { /* ignore */ }
}

describe.skipIf(isWindows)('Signal cleanup (POSIX)', () => {
  it('SIGINT-CLEANUP: containers removed on SIGINT (B-2-16)', async () => {
    if (!dockerAvailable) return;
    await spawnSandboxChild('SIGINT');
  }, { timeout: 60_000 });

  it('SIGTERM-CLEANUP: containers removed on SIGTERM (B-2-28)', async () => {
    if (!dockerAvailable) return;
    await spawnSandboxChild('SIGTERM');
  }, { timeout: 60_000 });
});

describe.skipIf(!isWindows)('Signal cleanup (Windows fallback)', () => {
  it('SIGINT-WINDOWS-LIMITATION: documented limitation — child.kill cannot deliver graceful signals on win32', () => {
    expect(isWindows).toBe(true);
    // No assertion against container cleanup: Node's child_process.kill on
    // Windows is always forceful. The user-space SIGINT handler in registry.ts
    // is verified by linux/macOS CI runs. On Windows, container cleanup is
    // covered by TTL expiry (B-2-15) and beforeExit handler for graceful exits.
  });
});
