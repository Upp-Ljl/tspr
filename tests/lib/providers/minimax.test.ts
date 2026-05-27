/**
 * tests/lib/providers/minimax.test.ts
 * Tests for MinimaxProvider.
 * Mocks globalThis.fetch — never makes real HTTP calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MinimaxProvider } from '../../../src/lib/providers/minimax.js';
import { LlmError } from '../../../src/lib/errors.js';
import { ErrCode } from '../../../src/lib/errors.js';

// ─────────────────────────────────────────────
// Fetch mock helpers
// ─────────────────────────────────────────────

type FetchBody = {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
};

let capturedRequest: { url: string; init: RequestInit } | null = null;

function mockFetchCapture(status: number, body: FetchBody): void {
  capturedRequest = null;
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
    capturedRequest = { url, init };
    const responseBody = JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => JSON.parse(responseBody),
      text: async () => responseBody,
    };
  }));
}

function successBody(content = 'hello', pt = 10, ct = 20): FetchBody {
  return {
    choices: [{ message: { content } }],
    usage: { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct },
  };
}

function mockFetch(status: number, body: FetchBody | string): void {
  const isString = typeof body === 'string';
  const responseBody = isString ? body : JSON.stringify(body);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(responseBody),
    text: async () => responseBody,
  }));
}

beforeEach(() => {
  vi.unstubAllGlobals();
  capturedRequest = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────
// Default URL / region
// ─────────────────────────────────────────────

describe('MinimaxProvider — default baseURL', () => {
  it('defaults to Chinese mainland URL (api.minimaxi.chat)', async () => {
    mockFetchCapture(200, successBody());
    const p = new MinimaxProvider();
    await p.chat({ model: 'haiku', prompt: 'test' });
    expect(capturedRequest?.url).toContain('api.minimaxi.chat');
  });

  it('region=intl uses api.minimaxi.io', async () => {
    mockFetchCapture(200, successBody());
    const p = new MinimaxProvider({ region: 'intl' });
    await p.chat({ model: 'haiku', prompt: 'test' });
    expect(capturedRequest?.url).toContain('api.minimaxi.io');
  });

  it('explicit baseURL overrides region', async () => {
    mockFetchCapture(200, successBody());
    const p = new MinimaxProvider({ baseURL: 'https://custom.example.com/v1' });
    await p.chat({ model: 'haiku', prompt: 'test' });
    expect(capturedRequest?.url).toBe('https://custom.example.com/v1/chat/completions');
  });
});

// ─────────────────────────────────────────────
// Default model aliases
// ─────────────────────────────────────────────

describe('MinimaxProvider — default model aliases', () => {
  it('maps haiku → abab6.5s-chat', async () => {
    mockFetchCapture(200, successBody());
    const p = new MinimaxProvider();
    await p.chat({ model: 'haiku', prompt: 'x' });
    const body = JSON.parse(capturedRequest?.init?.body as string);
    expect(body.model).toBe('abab6.5s-chat');
  });

  it('maps sonnet → MiniMax-Text-01', async () => {
    mockFetchCapture(200, successBody());
    const p = new MinimaxProvider();
    await p.chat({ model: 'sonnet', prompt: 'x' });
    const body = JSON.parse(capturedRequest?.init?.body as string);
    expect(body.model).toBe('MiniMax-Text-01');
  });

  it('maps opus → MiniMax-M1', async () => {
    mockFetchCapture(200, successBody());
    const p = new MinimaxProvider();
    await p.chat({ model: 'opus', prompt: 'x' });
    const body = JSON.parse(capturedRequest?.init?.body as string);
    expect(body.model).toBe('MiniMax-M1');
  });

  it('applies modelAliasOverrides', async () => {
    mockFetchCapture(200, successBody());
    const p = new MinimaxProvider({ modelAliasOverrides: { haiku: 'abab6.5-chat' } });
    await p.chat({ model: 'haiku', prompt: 'x' });
    const body = JSON.parse(capturedRequest?.init?.body as string);
    expect(body.model).toBe('abab6.5-chat');
  });
});

// ─────────────────────────────────────────────
// API key env var
// ─────────────────────────────────────────────

describe('MinimaxProvider — API key', () => {
  it('reads MINIMAX_API_KEY by default', async () => {
    mockFetchCapture(200, successBody());
    process.env['MINIMAX_API_KEY'] = 'mm-testkey';
    const p = new MinimaxProvider();
    await p.chat({ model: 'haiku', prompt: 'x' });
    const headers = capturedRequest?.init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer mm-testkey');
    delete process.env['MINIMAX_API_KEY'];
  });

  it('supports custom apiKeyEnv override', async () => {
    mockFetchCapture(200, successBody());
    process.env['MY_MM_KEY'] = 'mm-customkey';
    const p = new MinimaxProvider({ apiKeyEnv: 'MY_MM_KEY' });
    await p.chat({ model: 'haiku', prompt: 'x' });
    const headers = capturedRequest?.init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer mm-customkey');
    delete process.env['MY_MM_KEY'];
  });

  it('does NOT log the API key in error messages', async () => {
    mockFetch(401, 'Unauthorized');
    process.env['MINIMAX_API_KEY'] = 'mm-secret-key-do-not-log';
    const p = new MinimaxProvider();
    let caught: unknown;
    try { await p.chat({ model: 'haiku', prompt: 'test' }); } catch (e) { caught = e; }
    expect(String(caught)).not.toContain('mm-secret-key-do-not-log');
    delete process.env['MINIMAX_API_KEY'];
  });
});

// ─────────────────────────────────────────────
// Happy path / results
// ─────────────────────────────────────────────

describe('MinimaxProvider — happy path', () => {
  it('returns stdout from response content', async () => {
    mockFetch(200, successBody('minimax answer'));
    const p = new MinimaxProvider();
    const r = await p.chat({ model: 'haiku', prompt: 'test' });
    expect(r.stdout).toBe('minimax answer');
  });

  it('exitCode is 0 on success', async () => {
    mockFetch(200, successBody('ok'));
    const p = new MinimaxProvider();
    const r = await p.chat({ model: 'sonnet', prompt: 'test' });
    expect(r.exitCode).toBe(0);
  });

  it('costUsd is non-negative', async () => {
    mockFetch(200, successBody('ok', 500, 1000));
    const p = new MinimaxProvider();
    const r = await p.chat({ model: 'sonnet', prompt: 'test' });
    expect(r.costUsd).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────
// Error handling
// ─────────────────────────────────────────────

describe('MinimaxProvider — error handling', () => {
  it('throws LlmError on HTTP 4xx', async () => {
    mockFetch(403, 'Forbidden');
    const p = new MinimaxProvider();
    let caught: unknown;
    try { await p.chat({ model: 'haiku', prompt: 'test' }); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(LlmError);
    expect((caught as LlmError).code).toBe(ErrCode.ERR_CC_FAILED);
  });

  it('throws LlmError on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('Network unreachable')));
    const p = new MinimaxProvider();
    let caught: unknown;
    try { await p.chat({ model: 'haiku', prompt: 'test' }); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(LlmError);
    expect((caught as LlmError).code).toBe(ErrCode.ERR_CC_FAILED);
  });
});

// ─────────────────────────────────────────────
// Composition check — uses openai-compat HTTP path
// ─────────────────────────────────────────────

describe('MinimaxProvider — composition', () => {
  it('sends POST to /chat/completions (openai-compat path)', async () => {
    mockFetchCapture(200, successBody());
    const p = new MinimaxProvider();
    await p.chat({ model: 'haiku', prompt: 'x' });
    expect(capturedRequest?.url).toMatch(/\/chat\/completions$/);
  });

  it('sends temperature=0 and max_tokens=4096 (openai-compat defaults)', async () => {
    mockFetchCapture(200, successBody());
    const p = new MinimaxProvider();
    await p.chat({ model: 'haiku', prompt: 'x' });
    const body = JSON.parse(capturedRequest?.init?.body as string);
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(4096);
  });
});
