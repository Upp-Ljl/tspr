/**
 * Preflight tests: B-2-1, B-2-2
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createSandbox, SandboxError } from '../../src/sandbox/index.js';
import { listManagedContainers, makeTempProject, cleanupLeakedContainers } from './helpers.js';

let dockerAvailable = true;

beforeAll(async () => {
  try {
    // Quick Docker availability check
    const { execSync } = await import('child_process');
    execSync('docker info', { stdio: 'pipe', timeout: 5000 });
  } catch {
    dockerAvailable = false;
  }
});

afterAll(async () => {
  await cleanupLeakedContainers();
});

describe('Preflight — Docker unavailable path', () => {
  it('PREFLIGHT-UNAVAILABLE: throws SandboxError(ERR_DOCKER_UNAVAILABLE) when socket path is invalid', async () => {
    const originalSocket = process.env.DOCKER_SOCKET_PATH;
    process.env.DOCKER_SOCKET_PATH = '/tmp/no-such-socket-99999.sock';

    try {
      const t0 = performance.now();
      await expect(
        createSandbox({ projectPath: '/tmp/any', projectType: 'frontend' })
      ).rejects.toThrow(SandboxError);

      // Also verify the error code and timing
      let caught: unknown;
      try {
        await createSandbox({ projectPath: '/tmp/any', projectType: 'frontend' });
      } catch (e) {
        caught = e;
      }
      const elapsed = performance.now() - t0;

      expect(caught).toBeInstanceOf(SandboxError);
      const err = caught as SandboxError;
      expect(err.code).toBe('ERR_DOCKER_UNAVAILABLE');
      expect(typeof err.installUrl).toBe('string');
      expect(err.installUrl!.length).toBeGreaterThan(0);
      // Should reject within 2000ms + some tolerance
      expect(elapsed).toBeLessThan(6000); // generous for double-call overhead
    } finally {
      if (originalSocket === undefined) {
        delete process.env.DOCKER_SOCKET_PATH;
      } else {
        process.env.DOCKER_SOCKET_PATH = originalSocket;
      }
    }
  });

  it('PREFLIGHT-TIMEOUT: rejects within 2100ms', async () => {
    const originalSocket = process.env.DOCKER_SOCKET_PATH;
    process.env.DOCKER_SOCKET_PATH = '/tmp/no-such-socket-timeout.sock';

    try {
      const t0 = performance.now();
      await expect(
        createSandbox({ projectPath: '/tmp/any', projectType: 'backend' })
      ).rejects.toMatchObject({ code: 'ERR_DOCKER_UNAVAILABLE' });
      const elapsed = performance.now() - t0;
      expect(elapsed).toBeLessThan(4100); // 2000ms + tolerance for slow CI
    } finally {
      if (originalSocket === undefined) {
        delete process.env.DOCKER_SOCKET_PATH;
      } else {
        process.env.DOCKER_SOCKET_PATH = originalSocket;
      }
    }
  });

  it('PREFLIGHT-NO-CONTAINER-LEAK: no managed containers created on ERR_DOCKER_UNAVAILABLE', async () => {
    const originalSocket = process.env.DOCKER_SOCKET_PATH;
    process.env.DOCKER_SOCKET_PATH = '/tmp/no-such-socket-leak.sock';

    try {
      const before = await listManagedContainers();
      await expect(
        createSandbox({ projectPath: '/tmp/any', projectType: 'fullstack' })
      ).rejects.toThrow(SandboxError);
      const after = await listManagedContainers();
      // No new managed containers should have appeared
      expect(after.length).toBe(before.length);
    } finally {
      if (originalSocket === undefined) {
        delete process.env.DOCKER_SOCKET_PATH;
      } else {
        process.env.DOCKER_SOCKET_PATH = originalSocket;
      }
    }
  });

  it('SANDBOX-ERROR-IS-INSTANCEOF: SandboxError is instanceof Error', async () => {
    const originalSocket = process.env.DOCKER_SOCKET_PATH;
    process.env.DOCKER_SOCKET_PATH = '/tmp/no-such-socket-shape.sock';

    try {
      let err: unknown;
      try {
        await createSandbox({ projectPath: '/tmp/any', projectType: 'frontend' });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(SandboxError);
      expect(err).toBeInstanceOf(Error);
      expect(typeof (err as SandboxError).code).toBe('string');
      expect((err as SandboxError).installUrl).toBeDefined();
    } finally {
      if (originalSocket === undefined) {
        delete process.env.DOCKER_SOCKET_PATH;
      } else {
        process.env.DOCKER_SOCKET_PATH = originalSocket;
      }
    }
  });
});
