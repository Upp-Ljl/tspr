/**
 * dispose() and TTL tests: B-2-12, B-2-13, B-2-14, B-2-15, B-2-29
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import { createSandbox } from '../../src/sandbox/index.js';
import { makeTempProject, dockerInspect, cleanupLeakedContainers } from './helpers.js';

let dockerAvailable = true;

beforeAll(async () => {
  try {
    const { execSync } = await import('child_process');
    execSync('docker info', { stdio: 'pipe', timeout: 5000 });
    execSync('docker image inspect localsprite/sandbox-node:24', { stdio: 'pipe', timeout: 5000 });
  } catch {
    dockerAvailable = false;
    console.warn('[dispose.test] Docker or sandbox image not available — skipping');
  }
});

afterAll(async () => {
  await cleanupLeakedContainers();
});

describe('dispose', () => {
  it('DISPOSE-IDEMPOTENT: multiple dispose() calls do not throw (B-2-12)', async () => {
    if (!dockerAvailable) return;
    const handle = await createSandbox({
      projectPath: await makeTempProject(),
      projectType: 'frontend',
    });

    await handle.dispose();
    await handle.dispose(); // second — no-op
    await handle.dispose(); // third — no-op
    // None of the above should throw
  });

  it('DISPOSE-SETS-STATUS: status === disposed after dispose (B-2-13)', async () => {
    if (!dockerAvailable) return;
    const handle = await createSandbox({
      projectPath: await makeTempProject(),
      projectType: 'frontend',
    });

    expect(handle.status).toBe('running');
    await handle.dispose();
    expect(handle.status).toBe('disposed');
  });

  it('DISPOSE-CONTAINER-REMOVED: container not in docker ps -a after dispose (B-2-14)', async () => {
    if (!dockerAvailable) return;
    const handle = await createSandbox({
      projectPath: await makeTempProject(),
      projectType: 'backend',
    });

    const id = handle.id;
    await handle.dispose();

    // Container should be gone
    const inspect = await dockerInspect(id);
    if (inspect !== null) {
      // Container still present — check if it's removing
      const state = (inspect as Record<string, Record<string, unknown>>).State;
      const status = state?.Status as string | undefined;
      expect(['removing', 'dead', 'exited']).toContain(status);
      // Wait up to 5s for full removal
      await new Promise<void>((resolve) => setTimeout(resolve, 5000));
      const retry = await dockerInspect(id);
      expect(retry).toBeNull();
    }
  });

  it('RUNDIR-NEVER-DELETED: runDir persists after dispose (§5 Invariant 5)', async () => {
    if (!dockerAvailable) return;
    const handle = await createSandbox({
      projectPath: await makeTempProject(),
      projectType: 'frontend',
    });

    const runDir = handle.runDir;
    await handle.dispose();
    expect(fs.existsSync(runDir)).toBe(true);
  });

  it('TTL-AUTO-DISPOSE: container auto-removed after ttlMs (B-2-15)', async () => {
    if (!dockerAvailable) return;
    const handle = await createSandbox({
      projectPath: await makeTempProject(),
      projectType: 'frontend',
      ttlMs: 3_000,
    });

    // Do NOT call dispose() — wait for TTL
    await new Promise<void>((r) => setTimeout(r, 6_000));

    expect(handle.status).toBe('disposed');
    const inspect = await dockerInspect(handle.id);
    expect(inspect).toBeNull();
  }, { timeout: 30_000 });

  it('TTL-ENV-VAR-DEFAULT: LOCALSPRITE_SANDBOX_TTL_MS env var sets default TTL (B-2-15, §6)', async () => {
    if (!dockerAvailable) return;
    const originalTtl = process.env.LOCALSPRITE_SANDBOX_TTL_MS;
    process.env.LOCALSPRITE_SANDBOX_TTL_MS = '2000';

    try {
      const handle = await createSandbox({
        projectPath: await makeTempProject(),
        projectType: 'frontend',
        // No ttlMs — should pick up from env
      });

      await new Promise<void>((r) => setTimeout(r, 5_000));
      expect(handle.status).toBe('disposed');
    } finally {
      if (originalTtl === undefined) {
        delete process.env.LOCALSPRITE_SANDBOX_TTL_MS;
      } else {
        process.env.LOCALSPRITE_SANDBOX_TTL_MS = originalTtl;
      }
    }
  }, { timeout: 30_000 });
});
