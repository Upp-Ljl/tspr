/**
 * createSandbox tests: B-2-3, B-2-4, B-2-22, B-2-23, B-2-26
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { createSandbox, SandboxError } from '../../src/sandbox/index.js';
import {
  makeTempProject,
  cleanupLeakedContainers,
  dockerInspect,
} from './helpers.js';

let dockerAvailable = true;

beforeAll(async () => {
  try {
    const { execSync } = await import('child_process');
    execSync('docker info', { stdio: 'pipe', timeout: 5000 });
    // Ensure image exists
    execSync('docker image inspect tspr/sandbox-node:24', { stdio: 'pipe', timeout: 5000 });
  } catch {
    dockerAvailable = false;
    console.warn('[create.test] Docker or sandbox image not available — skipping Docker tests');
  }
});

afterAll(async () => {
  await cleanupLeakedContainers();
});

describe('createSandbox — success path', () => {
  it('CREATE-SUCCESS-FIELDS: returns running handle with correct fields (B-2-3)', async () => {
    if (!dockerAvailable) return;
    const projectPath = await makeTempProject();
    const handle = await createSandbox({ projectPath, projectType: 'frontend' });

    try {
      expect(handle.status).toBe('running');
      expect(typeof handle.id).toBe('string');
      expect(handle.id.length).toBeGreaterThan(0);
      expect(Number.isInteger(handle.port)).toBe(true);
      expect(handle.port).toBeGreaterThanOrEqual(1024);
      expect(handle.port).toBeLessThanOrEqual(65535);
      expect(typeof handle.runId).toBe('string');
      expect(handle.runId.length).toBeGreaterThan(0);
      expect(path.isAbsolute(handle.runDir)).toBe(true);
      expect(fs.existsSync(handle.runDir)).toBe(true);
    } finally {
      await handle.dispose();
    }
  });

  it('CREATE-RUNID-UNIQUE: concurrent sandboxes have unique runIds and IDs (B-2-3)', async () => {
    if (!dockerAvailable) return;
    const [h1, h2] = await Promise.all([
      createSandbox({ projectPath: await makeTempProject(), projectType: 'frontend' }),
      createSandbox({ projectPath: await makeTempProject(), projectType: 'frontend' }),
    ]);

    try {
      expect(h1.runId).not.toBe(h2.runId);
      expect(h1.id).not.toBe(h2.id);
    } finally {
      await Promise.all([h1.dispose(), h2.dispose()]);
    }
  });

  it('CREATE-MOUNT-WORK: project path is bind-mounted at /work (B-2-4)', async () => {
    if (!dockerAvailable) return;
    const projectPath = await makeTempProject({ 'hello.txt': 'mount-ok' });
    const handle = await createSandbox({ projectPath, projectType: 'backend' });

    try {
      const result = await handle.exec('cat /work/hello.txt');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('mount-ok');
    } finally {
      await handle.dispose();
    }
  });

  it('SANDBOX-LABELS-OBSERVABLE: containers carry tspr.managed=true label (§8)', async () => {
    if (!dockerAvailable) return;
    const projectPath = await makeTempProject();
    const handle = await createSandbox({ projectPath, projectType: 'backend' });

    try {
      const inspectData = await dockerInspect(handle.id) as Record<string, unknown> | null;
      expect(inspectData).not.toBeNull();
      const config = (inspectData as Record<string, Record<string, Record<string, string>>>).Config;
      expect(config?.Labels?.['tspr.managed']).toBe('true');
      expect(config?.Labels?.['tspr.run-id']).toBe(handle.runId);
    } finally {
      await handle.dispose();
    }
  });

  it('ENV-INJECTION-VISIBLE: env vars from options visible inside container (B-2-23)', async () => {
    if (!dockerAvailable) return;
    const handle = await createSandbox({
      projectPath: await makeTempProject(),
      projectType: 'backend',
      env: { MY_VAR: 'hello-sandbox' },
    });

    try {
      const result = await handle.exec('printenv MY_VAR');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('hello-sandbox');
    } finally {
      await handle.dispose();
    }
  });

  it('CONCURRENT-DISTINCT-PORTS: three concurrent sandboxes get distinct ports (B-2-22)', async () => {
    if (!dockerAvailable) return;
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
    } finally {
      await Promise.all(handles.map((h) => h.dispose()));
    }
  });

  it('MAX-CONCURRENT-EXCEEDED: throws ERR_MAX_CONCURRENT_EXCEEDED at limit (B-2-26)', async () => {
    if (!dockerAvailable) return;
    const originalMax = process.env.TSPR_SANDBOX_MAX_CONCURRENT;
    process.env.TSPR_SANDBOX_MAX_CONCURRENT = '1';
    let h1: Awaited<ReturnType<typeof createSandbox>> | undefined;

    try {
      h1 = await createSandbox({ projectPath: await makeTempProject(), projectType: 'frontend' });
      await expect(
        createSandbox({ projectPath: await makeTempProject(), projectType: 'frontend' })
      ).rejects.toMatchObject({ code: 'ERR_MAX_CONCURRENT_EXCEEDED' });
    } finally {
      await h1?.dispose();
      if (originalMax === undefined) {
        delete process.env.TSPR_SANDBOX_MAX_CONCURRENT;
      } else {
        process.env.TSPR_SANDBOX_MAX_CONCURRENT = originalMax;
      }
    }
  });

  it('ERR-IMAGE-BUILD-FAILED: nonexistent image throws ERR_IMAGE_BUILD_FAILED (§4)', async () => {
    if (!dockerAvailable) return;
    const originalImage = process.env.TSPR_SANDBOX_IMAGE;
    process.env.TSPR_SANDBOX_IMAGE = 'nonexistent-image:impossible-tag-12345';

    // Clear image cache so it re-checks
    const { clearImageCache } = await import('../../src/sandbox/image.js');
    clearImageCache();

    try {
      await expect(
        createSandbox({ projectPath: await makeTempProject(), projectType: 'frontend' })
      ).rejects.toMatchObject({ code: 'ERR_IMAGE_BUILD_FAILED' });
    } finally {
      if (originalImage === undefined) {
        delete process.env.TSPR_SANDBOX_IMAGE;
      } else {
        process.env.TSPR_SANDBOX_IMAGE = originalImage;
      }
      clearImageCache();
    }
  });

  it('NETWORK-MODE-NONE: networkMode=none blocks external network (§6)', async () => {
    if (!dockerAvailable) return;
    const handle = await createSandbox({
      projectPath: await makeTempProject(),
      projectType: 'backend',
      networkMode: 'none',
    });

    try {
      // Try to connect to external host — should fail
      const result = await handle.exec(
        'node -e "const h = require(\'https\'); const req = h.get(\'https://example.com\', () => { process.stdout.write(\'CONNECTED\\n\'); process.exit(0); }); req.on(\'error\', () => { process.stdout.write(\'NO_NETWORK\\n\'); process.exit(0); }); req.setTimeout(3000, () => { req.abort(); process.stdout.write(\'NO_NETWORK\\n\'); process.exit(0); });"',
        { timeout: 10_000 }
      );
      expect(
        result.stdout.includes('NO_NETWORK') || result.exitCode !== 0 || result.timedOut
      ).toBe(true);
    } finally {
      await handle.dispose();
    }
  });
});
