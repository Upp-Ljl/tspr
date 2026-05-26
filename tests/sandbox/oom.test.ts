/**
 * OOM detection tests: B-2-21, B-2-30
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import { createSandbox, SandboxError } from '../../src/sandbox/index.js';
import { makeTempProject, cleanupLeakedContainers } from './helpers.js';

let dockerAvailable = true;

beforeAll(async () => {
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 5000 });
    execSync('docker image inspect localsprite/sandbox-node:24', { stdio: 'pipe', timeout: 5000 });
  } catch {
    dockerAvailable = false;
    console.warn('[oom.test] Docker or sandbox image not available — skipping');
  }
});

afterAll(async () => {
  await cleanupLeakedContainers();
});

describe('OOM detection', () => {
  it('OOM-DETECTION: subsequent exec throws ERR_OUT_OF_MEMORY after OOM kill (B-2-21, B-2-30)', async () => {
    if (!dockerAvailable) return;

    // Create a sandbox with very low memory to trigger OOM
    // Note: OOM behavior is OS/Docker-version dependent
    // We create a 64MB container and try to allocate > 64MB
    const handle = await createSandbox({
      projectPath: await makeTempProject(),
      projectType: 'backend',
      memLimitMb: 64,
    });

    try {
      // Attempt to allocate > 64MB in Node.js
      // This may or may not trigger OOM depending on kernel settings
      await handle.exec('node -e "Buffer.alloc(128 * 1024 * 1024)"', { timeout: 15_000 }).catch(() => {});

      // Check if the container has been OOM-killed
      const { execSync: es } = await import('child_process');
      let oomKilled = false;
      try {
        const inspectResult = es(`docker inspect ${handle.id}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
        const info = JSON.parse(inspectResult);
        const state = Array.isArray(info) ? info[0]?.State : info?.State;
        oomKilled = state?.OOMKilled === true;
      } catch {
        // container may be gone
        oomKilled = false;
      }

      if (!oomKilled) {
        console.warn('OOM kill did not trigger — skipping OOM detection assertions (OOM behavior is OS/Docker dependent)');
        return;
      }

      // Now next exec should throw ERR_OUT_OF_MEMORY
      await expect(handle.exec('echo hi')).rejects.toMatchObject({
        code: 'ERR_OUT_OF_MEMORY',
      });
    } finally {
      await handle.dispose().catch(() => {});
    }
  }, { timeout: 60_000 });
});
