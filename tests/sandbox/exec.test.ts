/**
 * exec() tests: B-2-5, B-2-6, B-2-7, B-2-8, B-2-24
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createSandbox, SandboxError } from '../../src/sandbox/index.js';
import type { SandboxHandle } from '../../src/sandbox/index.js';
import { makeTempProject, cleanupLeakedContainers } from './helpers.js';

let dockerAvailable = true;
let sharedHandle: SandboxHandle | null = null;

beforeAll(async () => {
  try {
    const { execSync } = await import('child_process');
    execSync('docker info', { stdio: 'pipe', timeout: 5000 });
    execSync('docker image inspect tspr/sandbox-node:24', { stdio: 'pipe', timeout: 5000 });
    // Create a shared sandbox handle for exec tests
    sharedHandle = await createSandbox({
      projectPath: await makeTempProject(),
      projectType: 'backend',
    });
  } catch {
    dockerAvailable = false;
    console.warn('[exec.test] Docker or sandbox image not available — skipping');
  }
});

afterAll(async () => {
  if (sharedHandle) {
    await sharedHandle.dispose().catch(() => {});
    sharedHandle = null;
  }
  await cleanupLeakedContainers();
});

describe('exec — basic', () => {
  it('EXEC-EXIT-CODE-ZERO: exit 0 returns exitCode 0 (B-2-5)', async () => {
    if (!dockerAvailable || !sharedHandle) return;
    const result = await sharedHandle.exec('exit 0');
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it('EXEC-EXIT-CODE-NONZERO: exit 42 returns exitCode 42 (B-2-5)', async () => {
    if (!dockerAvailable || !sharedHandle) return;
    const result = await sharedHandle.exec('exit 42');
    expect(result.exitCode).toBe(42);
    expect(result.timedOut).toBe(false);
  });

  it('EXEC-STREAMS-SEPARATE: stdout and stderr captured separately (B-2-6)', async () => {
    if (!dockerAvailable || !sharedHandle) return;
    const result = await sharedHandle.exec('echo OUT; echo ERR >&2');
    expect(result.stdout).toContain('OUT');
    expect(result.stderr).toContain('ERR');
    expect(result.stdout).not.toContain('ERR');
    expect(result.stderr).not.toContain('OUT');
  });

  it('EXEC-TIMEOUT-ENFORCED: timedOut=true when command exceeds timeout (B-2-7)', async () => {
    if (!dockerAvailable || !sharedHandle) return;
    const T = 1500;
    const t0 = performance.now();
    const result = await sharedHandle.exec('sleep 60', { timeout: T });
    const elapsed = performance.now() - t0;

    expect(result.timedOut).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(T);
    // Grace window is T + 2000ms
    expect(elapsed).toBeLessThan(T + 4000);
  });

  it('EXEC-TIMEOUT-NO-THROW: timeout does NOT throw (B-2-7, §4)', async () => {
    if (!dockerAvailable || !sharedHandle) return;

    // Need a fresh handle since the previous test may have killed the container
    const handle = await createSandbox({
      projectPath: await makeTempProject(),
      projectType: 'backend',
    });
    try {
      let threw = false;
      try {
        await handle.exec('sleep 60', { timeout: 500 });
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
    } finally {
      await handle.dispose();
    }
  });

  it('EXEC-DURATION-RECORDED: durationMs is positive (B-2-7)', async () => {
    if (!dockerAvailable || !sharedHandle) return;
    const handle = await createSandbox({
      projectPath: await makeTempProject(),
      projectType: 'backend',
    });
    try {
      const result = await handle.exec('sleep 0.1');
      expect(result.durationMs).toBeGreaterThanOrEqual(50); // at least some time
      expect(result.durationMs).toBeLessThan(10000);
    } finally {
      await handle.dispose();
    }
  });

  it('EXEC-ON-DISPOSED-THROWS: exec on disposed sandbox throws SandboxError (B-2-8)', async () => {
    if (!dockerAvailable) return;
    const handle = await createSandbox({
      projectPath: await makeTempProject(),
      projectType: 'frontend',
    });
    await handle.dispose();
    expect(handle.status).toBe('disposed');

    await expect(handle.exec('echo hi')).rejects.toBeInstanceOf(SandboxError);
  });

  it('EXEC-CWD-OPTION: cwd option changes working directory', async () => {
    if (!dockerAvailable || !sharedHandle) return;
    const handle = await createSandbox({
      projectPath: await makeTempProject(),
      projectType: 'backend',
    });
    try {
      const result = await handle.exec('pwd', { cwd: '/tmp' });
      expect(result.stdout.trim()).toBe('/tmp');
      expect(result.exitCode).toBe(0);
    } finally {
      await handle.dispose();
    }
  });

  it('EXEC-DEFAULT-CWD-IS-WORK: default cwd is /work (B-2-4)', async () => {
    if (!dockerAvailable || !sharedHandle) return;
    const handle = await createSandbox({
      projectPath: await makeTempProject(),
      projectType: 'backend',
    });
    try {
      const result = await handle.exec('pwd');
      expect(result.stdout.trim()).toBe('/work');
    } finally {
      await handle.dispose();
    }
  });
});

describe('exec — env', () => {
  it('EXEC-ENV-OVERRIDE-ISOLATED: per-exec env does not persist (B-2-24)', async () => {
    if (!dockerAvailable) return;
    const handle = await createSandbox({
      projectPath: await makeTempProject(),
      projectType: 'backend',
      env: { BASE_VAR: 'base-value' },
    });
    try {
      const r1 = await handle.exec('printenv EXTRA_VAR', { env: { EXTRA_VAR: 'per-exec' } });
      expect(r1.stdout.trim()).toBe('per-exec');

      const r2 = await handle.exec('printenv EXTRA_VAR');
      // EXTRA_VAR should NOT be present in the base container env
      expect(r2.exitCode !== 0 || r2.stdout.trim() === '').toBe(true);
    } finally {
      await handle.dispose();
    }
  });

  it('EXEC-ENV-MERGE-WITH-BASE: per-exec env merges with base (B-2-24)', async () => {
    if (!dockerAvailable) return;
    const handle = await createSandbox({
      projectPath: await makeTempProject(),
      projectType: 'backend',
      env: { BASE_VAR: 'base-value' },
    });
    try {
      const result = await handle.exec('echo "$BASE_VAR $EXTRA_VAR"', {
        env: { EXTRA_VAR: 'extra' },
      });
      expect(result.stdout.trim()).toBe('base-value extra');
    } finally {
      await handle.dispose();
    }
  });
});
