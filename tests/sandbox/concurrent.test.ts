/**
 * Concurrent sandbox tests: B-2-22, B-2-3
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import { createSandbox } from '../../src/sandbox/index.js';
import { makeTempProject, cleanupLeakedContainers } from './helpers.js';

let dockerAvailable = true;

beforeAll(async () => {
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 5000 });
    execSync('docker image inspect tspr/sandbox-node:24', { stdio: 'pipe', timeout: 5000 });
  } catch {
    dockerAvailable = false;
    console.warn('[concurrent.test] Docker or sandbox image not available — skipping');
  }
});

afterAll(async () => {
  await cleanupLeakedContainers();
});

describe('concurrent sandboxes', () => {
  it('CONCURRENT-N3-ALL-EXEC: three concurrent sandboxes can all exec (B-2-22, B-2-3)', async () => {
    if (!dockerAvailable) return;

    // Ensure max concurrent is at least 3
    const originalMax = process.env.TSPR_SANDBOX_MAX_CONCURRENT;
    process.env.TSPR_SANDBOX_MAX_CONCURRENT = '3';

    try {
      const handles = await Promise.all([
        createSandbox({ projectPath: await makeTempProject(), projectType: 'frontend' }),
        createSandbox({ projectPath: await makeTempProject(), projectType: 'frontend' }),
        createSandbox({ projectPath: await makeTempProject(), projectType: 'frontend' }),
      ]);

      try {
        const ports = handles.map((h) => h.port);
        expect(new Set(ports).size).toBe(3);

        for (const h of handles) {
          expect(h.status).toBe('running');
        }

        const results = await Promise.all(handles.map((h) => h.exec('echo alive')));
        for (const r of results) {
          expect(r.exitCode).toBe(0);
          expect(r.stdout.trim()).toBe('alive');
        }
      } finally {
        await Promise.all(handles.map((h) => h.dispose()));
      }
    } finally {
      if (originalMax === undefined) {
        delete process.env.TSPR_SANDBOX_MAX_CONCURRENT;
      } else {
        process.env.TSPR_SANDBOX_MAX_CONCURRENT = originalMax;
      }
    }
  }, { timeout: 120_000 });
});
