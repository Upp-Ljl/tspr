/**
 * tests/lib/cc.test.ts
 * Tests for src/lib/cc.ts
 *
 * Uses tests/fixtures/fake-claude.mjs as a fake `claude` binary.
 * Invoked via: node <fake-claude.mjs>
 * The real `claude` CLI is never called.
 *
 * Fake claude env vars:
 *   FAKE_CLAUDE_EXIT_CODE — exit code (default: 0)
 *   FAKE_CLAUDE_STDOUT    — stdout text (default: '{"ok":true}')
 *   FAKE_CLAUDE_STDERR    — stderr text (default: '')
 *   FAKE_CLAUDE_DELAY_MS  — delay before exit in ms (default: 0)
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLlmClient } from '../../src/lib/cc.js';
import { LlmError } from '../../src/lib/errors.js';
import { ErrCode } from '../../src/lib/errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE_SCRIPT = path.join(__dirname, '..', 'fixtures', 'fake-claude.mjs');

type FakeEnv = {
  FAKE_CLAUDE_EXIT_CODE?: string;
  FAKE_CLAUDE_STDOUT?: string;
  FAKE_CLAUDE_STDERR?: string;
  FAKE_CLAUDE_DELAY_MS?: string;
};

/**
 * Create a LlmClient that invokes: node <fake-claude.mjs> [claude-args]
 * instead of the real `claude` binary.
 */
function fakeClient(opts?: { defaultTimeoutMs?: number }) {
  return createLlmClient({
    claudeBin: process.execPath,         // path to node
    claudeArgs: [FAKE_CLAUDE_SCRIPT],    // fake script is the first arg
    defaultTimeoutMs: opts?.defaultTimeoutMs ?? 10_000,
  });
}

// ─────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────

describe('createLlmClient', () => {
  it('returns a LlmClient with a run() method', () => {
    const client = createLlmClient({ claudeBin: 'claude' });
    expect(typeof client.run).toBe('function');
  });
});

// ─────────────────────────────────────────────
// Happy path
// ─────────────────────────────────────────────

describe('LlmClient.run — happy path', () => {
  it('resolves with stdout content', async () => {
    const client = fakeClient();
    const env: FakeEnv = { FAKE_CLAUDE_EXIT_CODE: '0', FAKE_CLAUDE_STDOUT: 'hello from claude' };
    const result = await client.run({ model: 'haiku', prompt: 'test', _env: env });
    expect(result.stdout).toBe('hello from claude');
  });

  it('resolves with exitCode 0', async () => {
    const client = fakeClient();
    const env: FakeEnv = { FAKE_CLAUDE_EXIT_CODE: '0', FAKE_CLAUDE_STDOUT: '{"result":"ok"}' };
    const result = await client.run({ model: 'sonnet', prompt: 'analyze', _env: env });
    expect(result.exitCode).toBe(0);
  });

  it('echoes modelUsed from options', async () => {
    const client = fakeClient();
    const env: FakeEnv = { FAKE_CLAUDE_EXIT_CODE: '0', FAKE_CLAUDE_STDOUT: 'ok' };
    const result = await client.run({ model: 'opus', prompt: 'analyze', _env: env });
    expect(result.modelUsed).toBe('opus');
  });

  it('durationMs is a non-negative number', async () => {
    const client = fakeClient();
    const env: FakeEnv = { FAKE_CLAUDE_EXIT_CODE: '0', FAKE_CLAUDE_STDOUT: 'ok' };
    const result = await client.run({ model: 'haiku', prompt: 'test', _env: env });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('costUsd is a non-negative number', async () => {
    const client = fakeClient();
    const env: FakeEnv = { FAKE_CLAUDE_EXIT_CODE: '0', FAKE_CLAUDE_STDOUT: 'some output text' };
    const result = await client.run({ model: 'haiku', prompt: 'test', _env: env });
    expect(result.costUsd).toBeGreaterThanOrEqual(0);
  });

  it('haiku produces lower costUsd than opus for same output length', async () => {
    const clientHaiku = fakeClient();
    const clientOpus  = fakeClient();
    const sameOutput  = 'x'.repeat(4000);

    const envBase: FakeEnv = { FAKE_CLAUDE_EXIT_CODE: '0', FAKE_CLAUDE_STDOUT: sameOutput };

    const [rHaiku, rOpus] = await Promise.all([
      clientHaiku.run({ model: 'haiku', prompt: 'p', _env: envBase }),
      clientOpus.run({ model: 'opus', prompt: 'p', _env: envBase }),
    ]);

    expect(rHaiku.costUsd).toBeLessThan(rOpus.costUsd);
  });

  it('empty stdout is returned as empty string', async () => {
    const client = fakeClient();
    const env: FakeEnv = { FAKE_CLAUDE_EXIT_CODE: '0', FAKE_CLAUDE_STDOUT: '' };
    const result = await client.run({ model: 'haiku', prompt: 'test', _env: env });
    expect(result.stdout).toBe('');
  });
});

// ─────────────────────────────────────────────
// Non-zero exit
// ─────────────────────────────────────────────

describe('LlmClient.run — non-zero exit code', () => {
  it('rejects with LlmError when exit code is non-zero', async () => {
    const client = fakeClient();
    const env: FakeEnv = {
      FAKE_CLAUDE_EXIT_CODE: '1',
      FAKE_CLAUDE_STDERR: 'error: no auth',
      FAKE_CLAUDE_STDOUT: '',
    };
    await expect(
      client.run({ model: 'haiku', prompt: 'test', _env: env }),
    ).rejects.toBeInstanceOf(LlmError);
  });

  it('rejected LlmError has code ERR_CC_FAILED', async () => {
    const client = fakeClient();
    const env: FakeEnv = { FAKE_CLAUDE_EXIT_CODE: '2', FAKE_CLAUDE_STDOUT: '' };
    let caught: unknown;
    try {
      await client.run({ model: 'haiku', prompt: 'test', _env: env });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LlmError);
    expect((caught as LlmError).code).toBe(ErrCode.ERR_CC_FAILED);
  });
});

// ─────────────────────────────────────────────
// Timeout
// ─────────────────────────────────────────────

describe('LlmClient.run — timeout', () => {
  it('rejects with LlmError (ERR_CC_TIMEOUT) when subprocess takes too long', async () => {
    const client = fakeClient({ defaultTimeoutMs: 100 });
    const env: FakeEnv = {
      FAKE_CLAUDE_DELAY_MS: '5000',
      FAKE_CLAUDE_EXIT_CODE: '0',
      FAKE_CLAUDE_STDOUT: 'late',
    };

    let caught: unknown;
    try {
      await client.run({ model: 'haiku', prompt: 'test', timeoutMs: 100, _env: env });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LlmError);
    expect((caught as LlmError).code).toBe(ErrCode.ERR_CC_TIMEOUT);
  }, 10_000);

  it('per-call timeoutMs overrides default', async () => {
    const client = fakeClient({ defaultTimeoutMs: 60_000 });
    const env: FakeEnv = {
      FAKE_CLAUDE_DELAY_MS: '5000',
      FAKE_CLAUDE_EXIT_CODE: '0',
      FAKE_CLAUDE_STDOUT: 'late',
    };

    let caught: unknown;
    try {
      await client.run({ model: 'haiku', prompt: 'test', timeoutMs: 100, _env: env });
    } catch (e) {
      caught = e;
    }
    expect((caught as LlmError).code).toBe(ErrCode.ERR_CC_TIMEOUT);
  }, 10_000);
});

// ─────────────────────────────────────────────
// Invalid binary
// ─────────────────────────────────────────────

describe('LlmClient.run — invalid binary', () => {
  it('rejects with LlmError when binary does not exist', async () => {
    const client = createLlmClient({
      claudeBin: 'definitely-not-a-real-binary-xyz',
      defaultTimeoutMs: 5_000,
    });

    let caught: unknown;
    try {
      await client.run({ model: 'haiku', prompt: 'test' });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(LlmError);
    expect((caught as LlmError).code).toBe(ErrCode.ERR_CC_FAILED);
  });
});
