/**
 * tests/lib/config-write.test.ts
 *
 * Tests for writeConfig() in src/lib/config.ts.
 * Covers: atomic write, zod validation, apiKey rejection, path safety.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeConfig, loadConfig, TsprConfigSchema } from '../../src/lib/config.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tmpConfigPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tspr-cfg-write-test-'));
  return path.join(dir, 'config.json');
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('writeConfig', () => {
  const tempPaths: string[] = [];

  afterEach(() => {
    for (const p of tempPaths.splice(0)) {
      try { fs.rmSync(path.dirname(p), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  function track(p: string): string {
    tempPaths.push(p);
    return p;
  }

  // ── WRITE-001: writes valid config and returns validated object ───────────
  it('WRITE-001: writes a valid config and returns the validated TsprConfig', () => {
    const cfgPath = track(tmpConfigPath());
    const input = { provider: 'claude' as const };
    const result = writeConfig(input, cfgPath);

    expect(result.provider).toBe('claude');
    expect(fs.existsSync(cfgPath)).toBe(true);
  });

  // ── WRITE-002: written file is round-trippable with loadConfig ───────────
  it('WRITE-002: written file is round-trippable via loadConfig', () => {
    const cfgPath = track(tmpConfigPath());
    const input = {
      provider: 'openai-compat' as const,
      openaiCompat: { baseURL: 'https://api.example.com/v1', apiKeyEnv: 'MY_KEY_ENV' },
    };
    writeConfig(input, cfgPath);

    const loaded = loadConfig(cfgPath);
    expect(loaded.provider).toBe('openai-compat');
    expect(loaded.openaiCompat?.baseURL).toBe('https://api.example.com/v1');
    expect(loaded.openaiCompat?.apiKeyEnv).toBe('MY_KEY_ENV');
  });

  // ── WRITE-003: rejects literal apiKey field ───────────────────────────────
  it('WRITE-003: rejects input with top-level apiKey field', () => {
    const cfgPath = track(tmpConfigPath());
    expect(() =>
      writeConfig({ provider: 'claude', apiKey: 'sk-ant-xxxxxxxxxxx' }, cfgPath),
    ).toThrow(/literal API key/i);

    // File must NOT have been created
    expect(fs.existsSync(cfgPath)).toBe(false);
  });

  // ── WRITE-004: rejects nested *_API_KEY field ─────────────────────────────
  it('WRITE-004: rejects input containing a nested OPENAI_API_KEY field', () => {
    const cfgPath = track(tmpConfigPath());
    expect(() =>
      writeConfig(
        { openaiCompat: { baseURL: 'https://api.example.com/v1', OPENAI_API_KEY: 'sk-...' } },
        cfgPath,
      ),
    ).toThrow(/literal API key/i);
  });

  // ── WRITE-005: rejects invalid zod schema ─────────────────────────────────
  it('WRITE-005: throws (with validation message) on schema-invalid input', () => {
    const cfgPath = track(tmpConfigPath());
    expect(() =>
      writeConfig({ provider: 'bad-provider-xyz' }, cfgPath),
    ).toThrow(/validation/i);

    expect(fs.existsSync(cfgPath)).toBe(false);
  });

  // ── WRITE-006: atomic write — no .tmp file left behind on success ─────────
  it('WRITE-006: no .tmp file remains after a successful write', () => {
    const cfgPath = track(tmpConfigPath());
    writeConfig({ provider: 'minimax' }, cfgPath);

    const tmpPath = `${cfgPath}.tmp`;
    expect(fs.existsSync(tmpPath)).toBe(false);
    expect(fs.existsSync(cfgPath)).toBe(true);
  });

  // ── WRITE-007: empty object is accepted (all fields optional) ─────────────
  it('WRITE-007: empty object writes successfully (all fields optional)', () => {
    const cfgPath = track(tmpConfigPath());
    const result = writeConfig({}, cfgPath);
    expect(result).toEqual({});
    expect(fs.existsSync(cfgPath)).toBe(true);
  });

  // ── WRITE-008: creates parent directory if absent ─────────────────────────
  it('WRITE-008: creates parent directory if it does not exist', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tspr-cfg-mkdir-'));
    const cfgPath = path.join(base, 'nested', 'config.json');
    track(cfgPath);
    tempPaths.push(base); // ensure cleanup

    writeConfig({ provider: 'claude' }, cfgPath);
    expect(fs.existsSync(cfgPath)).toBe(true);
  });

  // ── WRITE-009: modelAlias is preserved correctly ──────────────────────────
  it('WRITE-009: modelAlias fields are preserved correctly', () => {
    const cfgPath = track(tmpConfigPath());
    const input = {
      modelAlias: { haiku: 'my-haiku-4', sonnet: 'my-sonnet-4' },
    };
    const result = writeConfig(input, cfgPath);
    expect(result.modelAlias?.haiku).toBe('my-haiku-4');
    expect(result.modelAlias?.sonnet).toBe('my-sonnet-4');

    const loaded = loadConfig(cfgPath);
    expect(loaded.modelAlias?.haiku).toBe('my-haiku-4');
  });

  // ── WRITE-010: rejects invalid URL in openaiCompat.baseURL ───────────────
  it('WRITE-010: rejects invalid URL in openaiCompat.baseURL', () => {
    const cfgPath = track(tmpConfigPath());
    expect(() =>
      writeConfig({ openaiCompat: { baseURL: 'not-a-url' } }, cfgPath),
    ).toThrow(/validation/i);
  });
});
