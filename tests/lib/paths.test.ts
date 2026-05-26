/**
 * tests/lib/paths.test.ts
 * Tests for src/lib/paths.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// We test with real os.homedir() — no mocking needed; just assert structure.
import {
  localspriteHome,
  runsDir,
  dbPath,
  configPath,
  ensureDir,
} from '../../src/lib/paths.js';

describe('paths', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-paths-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('localspriteHome', () => {
    it('returns a non-empty absolute path', () => {
      const home = localspriteHome();
      expect(home).toBeTruthy();
      expect(path.isAbsolute(home)).toBe(true);
    });

    it('ends with .localsprite', () => {
      const home = localspriteHome();
      expect(home.endsWith('.localsprite') || home.endsWith('.localsprite' + path.sep)).toBe(true);
    });

    it('is under os.homedir()', () => {
      const home = localspriteHome();
      expect(home.startsWith(os.homedir())).toBe(true);
    });
  });

  describe('runsDir', () => {
    it('is localspriteHome() + /runs', () => {
      expect(runsDir()).toBe(path.join(localspriteHome(), 'runs'));
    });

    it('is an absolute path', () => {
      expect(path.isAbsolute(runsDir())).toBe(true);
    });
  });

  describe('dbPath', () => {
    it('is localspriteHome() + /db.sqlite', () => {
      expect(dbPath()).toBe(path.join(localspriteHome(), 'db.sqlite'));
    });

    it('ends with db.sqlite', () => {
      expect(dbPath().endsWith('db.sqlite')).toBe(true);
    });
  });

  describe('configPath', () => {
    it('is localspriteHome() + /config.json', () => {
      expect(configPath()).toBe(path.join(localspriteHome(), 'config.json'));
    });

    it('ends with config.json', () => {
      expect(configPath().endsWith('config.json')).toBe(true);
    });
  });

  describe('ensureDir', () => {
    it('creates a new directory', () => {
      const newDir = path.join(tmpDir, 'new-dir');
      expect(fs.existsSync(newDir)).toBe(false);
      ensureDir(newDir);
      expect(fs.existsSync(newDir)).toBe(true);
    });

    it('creates nested directories (mkdir -p behaviour)', () => {
      const nested = path.join(tmpDir, 'a', 'b', 'c');
      ensureDir(nested);
      expect(fs.existsSync(nested)).toBe(true);
    });

    it('is idempotent — calling twice does not throw', () => {
      const dir = path.join(tmpDir, 'idempotent');
      ensureDir(dir);
      expect(() => ensureDir(dir)).not.toThrow();
    });

    it('does not throw when the directory already exists', () => {
      expect(() => ensureDir(tmpDir)).not.toThrow();
    });
  });
});
