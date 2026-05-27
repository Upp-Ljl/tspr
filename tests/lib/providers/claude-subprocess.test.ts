/**
 * tests/lib/providers/claude-subprocess.test.ts
 *
 * Tests for ClaudeSubprocessProvider.
 * Uses tests/fixtures/fake-claude.mjs to avoid calling real claude CLI.
 *
 * Env vars for fake-claude.mjs:
 *   FAKE_CLAUDE_EXIT_CODE  — exit code (default: 0)
 *   FAKE_CLAUDE_STDOUT     — stdout text (default: '{"ok":true}')
 *   FAKE_CLAUDE_STDERR     — stderr text (default: '')
 *   FAKE_CLAUDE_DELAY_MS   — delay before exit in ms (default: 0)
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeSubprocessProvider } from '../../../src/lib/providers/claude-subprocess.js';
import { LlmError } from '../../../src/lib/errors.js';
import { ErrCode } from '../../../src/lib/errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(__dirname, '..', '..', 'fixtures', 'fake-claude.mjs');

type FakeEnv = {
  FAKE_CLAUDE_EXIT_CODE?: string;
  FAKE_CLAUDE_STDOUT?: string;
  FAKE_CLAUDE_STDERR?: string;
  FAKE_CLAUDE_DELAY_MS?: string;
};

function fakeProvider(opts?: { defaultTimeoutMs?: number }) {
  return new ClaudeSubprocessProvider({
    binary: process.execPath,
    extraArgs: [FAKE_CLAUDE],
    defaultTimeoutMs: opts?.defaultTimeoutMs ?? 10_000,
  });
}

// ─────────────────────────────────────────────
// Happy path
// ─────────────────────────────────────────────

describe('ClaudeSubprocessProvider — happy path', () => {
  it('returns stdout from fake subprocess', async () => {
    const p = fakeProvider();
    const env: FakeEnv = { FAKE_CLAUDE_EXIT_CODE: '0', FAKE_CLAUDE_STDOUT: 'result from claude' };
    const result = await p.chat({ model: 'haiku', prompt: 'test', _env: env });
    expect(result.stdout).toBe('result from claude');
  });

  it('exitCode is 0 on success', async () => {
    const p = fakeProvider();
    const env: FakeEnv = { FAKE_CLAUDE_EXIT_CODE: '0', FAKE_CLAUDE_STDOUT: 'ok' };
    const result = await p.chat({ model: 'sonnet', prompt: 'test', _env: env });
    expect(result.exitCode).toBe(0);
  });

  it('modelUsed echoes the alias', async () => {
    const p = fakeProvider();
    const env: FakeEnv = { FAKE_CLAUDE_EXIT_CODE: '0', FAKE_CLAUDE_STDOUT: 'ok' };
    const result = await p.chat({ model: 'opus', prompt: 'test', _env: env });
    expect(result.modelUsed).toBe('opus');
  });

  it('durationMs is a non-negative number', async () => {
    const p = fakeProvider();
    const env: FakeEnv = { FAKE_CLAUDE_EXIT_CODE: '0', FAKE_CLAUDE_STDOUT: 'ok' };
    const result = await p.chat({ model: 'haiku', prompt: 'test', _env: env });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('costUsd is a non-negative number', async () => {
    const p = fakeProvider();
    const env: FakeEnv = { FAKE_CLAUDE_EXIT_CODE: '0', FAKE_CLAUDE_STDOUT: 'some output' };
    const result = await p.chat({ model: 'haiku', prompt: 'test', _env: env });
    expect(result.costUsd).toBeGreaterThanOrEqual(0);
  });

  it('haiku costUsd is lower than opus for same output', async () => {
    const pHaiku = fakeProvider();
    const pOpus = fakeProvider();
    const text = 'x'.repeat(4000);
    const env: FakeEnv = { FAKE_CLAUDE_EXIT_CODE: '0', FAKE_CLAUDE_STDOUT: text };
    const [rH, rO] = await Promise.all([
      pHaiku.chat({ model: 'haiku', prompt: 'p', _env: env }),
      pOpus.chat({ model: 'opus', prompt: 'p', _env: env }),
    ]);
    expect(rH.costUsd).toBeLessThan(rO.costUsd);
  });
});

// ─────────────────────────────────────────────
// Non-zero exit
// ─────────────────────────────────────────────

describe('ClaudeSubprocessProvider — non-zero exit', () => {
  it('rejects with LlmError on non-zero exit', async () => {
    const p = fakeProvider();
    const env: FakeEnv = { FAKE_CLAUDE_EXIT_CODE: '1', FAKE_CLAUDE_STDERR: 'auth failed' };
    await expect(p.chat({ model: 'haiku', prompt: 'x', _env: env })).rejects.toBeInstanceOf(LlmError);
  });

  it('LlmError has code ERR_CC_FAILED on non-zero exit', async () => {
    const p = fakeProvider();
    const env: FakeEnv = { FAKE_CLAUDE_EXIT_CODE: '2', FAKE_CLAUDE_STDOUT: '' };
    let caught: unknown;
    try { await p.chat({ model: 'haiku', prompt: 'x', _env: env }); } catch (e) { caught = e; }
    expect((caught as LlmError).code).toBe(ErrCode.ERR_CC_FAILED);
  });
});

// ─────────────────────────────────────────────
// Timeout
// ─────────────────────────────────────────────

describe('ClaudeSubprocessProvider — timeout', () => {
  it('rejects with ERR_CC_TIMEOUT on slow subprocess', async () => {
    const p = fakeProvider({ defaultTimeoutMs: 100 });
    const env: FakeEnv = { FAKE_CLAUDE_DELAY_MS: '5000', FAKE_CLAUDE_EXIT_CODE: '0', FAKE_CLAUDE_STDOUT: 'late' };
    let caught: unknown;
    try { await p.chat({ model: 'haiku', prompt: 'x', timeoutMs: 100, _env: env }); }
    catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(LlmError);
    expect((caught as LlmError).code).toBe(ErrCode.ERR_CC_TIMEOUT);
  }, 10_000);
});

// ─────────────────────────────────────────────
// Invalid binary
// ─────────────────────────────────────────────

describe('ClaudeSubprocessProvider — invalid binary', () => {
  it('rejects with LlmError when binary does not exist', async () => {
    const p = new ClaudeSubprocessProvider({ binary: 'definitely-not-a-binary-xyz' });
    let caught: unknown;
    try { await p.chat({ model: 'haiku', prompt: 'x' }); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(LlmError);
    expect((caught as LlmError).code).toBe(ErrCode.ERR_CC_FAILED);
  });
});

// ─────────────────────────────────────────────
// Model alias overrides
// ─────────────────────────────────────────────

describe('ClaudeSubprocessProvider — model alias overrides', () => {
  it('applies modelAliasOverrides for haiku', async () => {
    const p = new ClaudeSubprocessProvider({
      binary: process.execPath,
      extraArgs: [FAKE_CLAUDE],
      modelAliasOverrides: { haiku: 'claude-haiku-custom' },
    });
    // Smoke: it runs without error (fake-claude ignores --model value)
    const env: FakeEnv = { FAKE_CLAUDE_EXIT_CODE: '0', FAKE_CLAUDE_STDOUT: 'ok' };
    const r = await p.chat({ model: 'haiku', prompt: 'x', _env: env });
    expect(r.stdout).toBe('ok');
  });
});
