/**
 * tests/lib/config.test.ts
 * Tests for src/lib/config.ts — loadConfig() + Zod validation + env-var overrides.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig, LocalSpriteConfigSchema } from '../../src/lib/config.js';

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function tmpConfigFile(content: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-cfg-test-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(content), 'utf-8');
  return file;
}

function tmpBadJsonFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-cfg-test-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{ not valid json }', 'utf-8');
  return file;
}

// Saved env state
let savedEnv: Record<string, string | undefined> = {};

const ENV_KEYS = ['LOCALSPRITE_PROVIDER', 'LOCALSPRITE_BASE_URL', 'LOCALSPRITE_API_KEY_ENV'];

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = savedEnv[k];
    }
  }
});

// ─────────────────────────────────────────────
// Schema validation
// ─────────────────────────────────────────────

describe('LocalSpriteConfigSchema', () => {
  it('accepts empty object', () => {
    const r = LocalSpriteConfigSchema.safeParse({});
    expect(r.success).toBe(true);
  });

  it('accepts valid config with provider=claude', () => {
    const r = LocalSpriteConfigSchema.safeParse({ provider: 'claude' });
    expect(r.success).toBe(true);
  });

  it('accepts valid config with provider=openai-compat', () => {
    const r = LocalSpriteConfigSchema.safeParse({ provider: 'openai-compat' });
    expect(r.success).toBe(true);
  });

  it('accepts valid config with provider=minimax', () => {
    const r = LocalSpriteConfigSchema.safeParse({ provider: 'minimax' });
    expect(r.success).toBe(true);
  });

  it('rejects unknown provider value', () => {
    const r = LocalSpriteConfigSchema.safeParse({ provider: 'anthropic-direct' });
    expect(r.success).toBe(false);
  });

  it('accepts modelAlias with partial overrides', () => {
    const r = LocalSpriteConfigSchema.safeParse({ modelAlias: { haiku: 'my-haiku' } });
    expect(r.success).toBe(true);
  });

  it('accepts openaiCompat with baseURL', () => {
    const r = LocalSpriteConfigSchema.safeParse({
      openaiCompat: { baseURL: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY' },
    });
    expect(r.success).toBe(true);
  });

  it('rejects openaiCompat with invalid URL', () => {
    const r = LocalSpriteConfigSchema.safeParse({
      openaiCompat: { baseURL: 'not-a-url' },
    });
    expect(r.success).toBe(false);
  });

  it('accepts minimax with baseURL', () => {
    const r = LocalSpriteConfigSchema.safeParse({
      minimax: { baseURL: 'https://api.minimaxi.chat/v1', apiKeyEnv: 'MINIMAX_API_KEY' },
    });
    expect(r.success).toBe(true);
  });
});

// ─────────────────────────────────────────────
// loadConfig — file-based
// ─────────────────────────────────────────────

describe('loadConfig — file-based', () => {
  it('returns empty config when file does not exist', () => {
    const cfg = loadConfig('/nonexistent/path/config.json');
    expect(cfg).toEqual({});
  });

  it('loads provider from file', () => {
    const file = tmpConfigFile({ provider: 'minimax' });
    const cfg = loadConfig(file);
    expect(cfg.provider).toBe('minimax');
  });

  it('loads openaiCompat from file', () => {
    const file = tmpConfigFile({ openaiCompat: { baseURL: 'https://custom.api/v1' } });
    const cfg = loadConfig(file);
    expect(cfg.openaiCompat?.baseURL).toBe('https://custom.api/v1');
  });

  it('throws on invalid JSON', () => {
    const file = tmpBadJsonFile();
    expect(() => loadConfig(file)).toThrow(/not valid JSON/);
  });

  it('throws on schema validation failure', () => {
    const file = tmpConfigFile({ provider: 'invalid-provider-xyz' });
    expect(() => loadConfig(file)).toThrow(/failed validation/);
  });
});

// ─────────────────────────────────────────────
// loadConfig — env var overrides
// ─────────────────────────────────────────────

describe('loadConfig — env var overrides', () => {
  it('LOCALSPRITE_PROVIDER overrides config.provider', () => {
    const file = tmpConfigFile({ provider: 'claude' });
    process.env['LOCALSPRITE_PROVIDER'] = 'minimax';
    const cfg = loadConfig(file);
    expect(cfg.provider).toBe('minimax');
  });

  it('LOCALSPRITE_PROVIDER with invalid value throws', () => {
    const file = tmpConfigFile({});
    process.env['LOCALSPRITE_PROVIDER'] = 'bad-provider';
    expect(() => loadConfig(file)).toThrow(/LOCALSPRITE_PROVIDER/);
  });

  it('LOCALSPRITE_API_KEY_ENV overrides apiKeyEnv for openai-compat', () => {
    const file = tmpConfigFile({ provider: 'openai-compat' });
    process.env['LOCALSPRITE_API_KEY_ENV'] = 'MY_CUSTOM_KEY';
    const cfg = loadConfig(file);
    expect(cfg.openaiCompat?.apiKeyEnv).toBe('MY_CUSTOM_KEY');
  });

  it('LOCALSPRITE_API_KEY_ENV overrides apiKeyEnv for minimax', () => {
    const file = tmpConfigFile({ provider: 'minimax' });
    process.env['LOCALSPRITE_API_KEY_ENV'] = 'MY_MM_KEY';
    const cfg = loadConfig(file);
    expect(cfg.minimax?.apiKeyEnv).toBe('MY_MM_KEY');
  });

  it('LOCALSPRITE_BASE_URL overrides baseURL for openai-compat', () => {
    const file = tmpConfigFile({ provider: 'openai-compat' });
    process.env['LOCALSPRITE_BASE_URL'] = 'https://override.example.com/v1';
    const cfg = loadConfig(file);
    expect(cfg.openaiCompat?.baseURL).toBe('https://override.example.com/v1');
  });

  it('LOCALSPRITE_BASE_URL overrides baseURL for minimax', () => {
    const file = tmpConfigFile({ provider: 'minimax' });
    process.env['LOCALSPRITE_BASE_URL'] = 'https://mm-override.example.com/v1';
    const cfg = loadConfig(file);
    expect(cfg.minimax?.baseURL).toBe('https://mm-override.example.com/v1');
  });
});
