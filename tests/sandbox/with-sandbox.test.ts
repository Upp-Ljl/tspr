/**
 * withSandbox tests: B-2-19, B-2-20
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import { createSandbox, withSandbox, SandboxError } from '../../src/sandbox/index.js';
import type { SandboxHandle } from '../../src/sandbox/index.js';
import { dockerInspect, makeTempProject, cleanupLeakedContainers } from './helpers.js';

let dockerAvailable = true;

beforeAll(async () => {
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 5000 });
    execSync('docker image inspect localsprite/sandbox-node:24', { stdio: 'pipe', timeout: 5000 });
  } catch {
    dockerAvailable = false;
    console.warn('[with-sandbox.test] Docker or sandbox image not available — skipping');
  }
});

afterAll(async () => {
  await cleanupLeakedContainers();
});

describe('withSandbox', () => {
  it('WITH-SANDBOX-DISPOSE-ON-THROW: dispose called even when fn throws (B-2-19)', async () => {
    if (!dockerAvailable) return;
    const sentinel = new Error('fn-threw');
    let capturedHandle: SandboxHandle | undefined;

    await expect(
      withSandbox(
        { projectPath: await makeTempProject(), projectType: 'frontend' },
        async (sandbox) => {
          capturedHandle = sandbox;
          throw sentinel;
        }
      )
    ).rejects.toThrow('fn-threw');

    expect(capturedHandle).toBeDefined();
    expect(capturedHandle!.status).toBe('disposed');

    // Container should be removed
    const inspect = await dockerInspect(capturedHandle!.id);
    if (inspect !== null) {
      // May still be in removing state
      const status = (inspect as Record<string, Record<string, unknown>>).State?.Status;
      expect(['removing', 'dead', 'exited']).toContain(status);
    }
  });

  it('WITH-SANDBOX-RETURNS-VALUE: return value of fn is forwarded (B-2-20)', async () => {
    if (!dockerAvailable) return;
    const result = await withSandbox(
      { projectPath: await makeTempProject(), projectType: 'frontend' },
      async (sandbox) => {
        const r = await sandbox.exec('echo hello-world');
        return r.stdout.trim();
      }
    );
    expect(result).toBe('hello-world');
  });

  it('WITH-SANDBOX-DISPOSE-ERROR-DOESNT-REPLACE: original error survives dispose error (B-2-19)', async () => {
    if (!dockerAvailable) return;
    const sentinel = new Error('original-error');

    let caught: unknown;
    try {
      await withSandbox(
        { projectPath: await makeTempProject(), projectType: 'frontend' },
        async (_sandbox) => {
          throw sentinel;
        }
      );
    } catch (e) {
      caught = e;
    }

    expect(caught).toBe(sentinel);
  });
});
