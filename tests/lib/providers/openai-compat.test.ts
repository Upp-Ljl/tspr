/**
 * tests/lib/providers/openai-compat.test.ts
 * Tests for OpenAICompatProvider.
 * Mocks globalThis.fetch — never makes real HTTP calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAICompatProvider } from '../../../src/lib/providers/openai-compat.js';
import { LlmError } from '../../../src/lib/errors.js';
import { ErrCode } from '../../../src/lib/errors.js';

// ─────────────────────────────────────────────
// Fetch mock helpers
// ─────────────────────────────────────────────

type FetchBody = {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
};

function mockFetch(
  status: number,
  body: FetchBody | string,
  headers?: Record<string, string>,
): void {
  const isString = typeof body === 'string';
  const responseBody = isString ? body : JSON.stringify(body);

  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(responseBody),
    text: async () => responseBody,
    headers: new Headers(headers ?? {}),
  }));
}

function successBody(content = 'hello world', promptTokens = 10, completionTokens = 20): FetchBody {
  return {
    choices: [{ message: { content } }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
  };
}

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

beforeEach(() => {
  vi.unstubAllGlobals();
  capturedRequest = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────
// Happy path
// ─────────────────────────────────────────────

describe('OpenAICompatProvider — happy path', () => {
  it('returns content from choices[0].message.content', async () => {
    mockFetch(200, successBody('answer text'));
    const p = new OpenAICompatProvider({ apiKeyEnv: 'TEST_API_KEY' });
    process.env['TEST_API_KEY'] = 'sk-test';
    const r = await p.chat({ model: 'haiku', prompt: 'test' });
    expect(r.stdout).toBe('answer text');
    delete process.env['TEST_API_KEY'];
  });

  it('exitCode is 0 on success', async () => {
    mockFetch(200, successBody('ok'));
    const p = new OpenAICompatProvider();
    const r = await p.chat({ model: 'sonnet', prompt: 'test' });
    expect(r.exitCode).toBe(0);
  });

  it('modelUsed echoes the alias', async () => {
    mockFetch(200, successBody('ok'));
    const p = new OpenAICompatProvider();
    const r = await p.chat({ model: 'opus', prompt: 'test' });
    expect(r.modelUsed).toBe('opus');
  });

  it('durationMs is a non-negative number', async () => {
    mockFetch(200, successBody('ok'));
    const p = new OpenAICompatProvider();
    const r = await p.chat({ model: 'haiku', prompt: 'test' });
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('computes costUsd from usage tokens', async () => {
    mockFetch(200, successBody('ok', 1000, 2000));
    const p = new OpenAICompatProvider();
    const r = await p.chat({ model: 'haiku', prompt: 'test' });
    expect(r.costUsd).toBeGreaterThan(0);
  });

  it('costUsd is 0 when usage field is absent', async () => {
    mockFetch(200, { choices: [{ message: { content: 'ok' } }] });
    const p = new OpenAICompatProvider();
    const r = await p.chat({ model: 'haiku', prompt: 'test' });
    expect(r.costUsd).toBe(0);
  });
});

// ─────────────────────────────────────────────
// Request shape
// ─────────────────────────────────────────────

describe('OpenAICompatProvider — request shape', () => {
  it('posts to baseURL/chat/completions', async () => {
    mockFetchCapture(200, successBody());
    const p = new OpenAICompatProvider({ baseURL: 'https://custom.api/v1' });
    await p.chat({ model: 'haiku', prompt: 'test' });
    expect(capturedRequest?.url).toBe('https://custom.api/v1/chat/completions');
  });

  it('sends Content-Type application/json', async () => {
    mockFetchCapture(200, successBody());
    const p = new OpenAICompatProvider();
    await p.chat({ model: 'haiku', prompt: 'test' });
    const headers = capturedRequest?.init?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('sends Authorization Bearer header when API key is set', async () => {
    mockFetchCapture(200, successBody());
    process.env['OPENAI_API_KEY'] = 'sk-mykey';
    const p = new OpenAICompatProvider();
    await p.chat({ model: 'haiku', prompt: 'test' });
    const headers = capturedRequest?.init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-mykey');
    delete process.env['OPENAI_API_KEY'];
  });

  it('does NOT include Authorization header when key is absent', async () => {
    mockFetchCapture(200, successBody());
    const savedKey = process.env['OPENAI_API_KEY'];
    delete process.env['OPENAI_API_KEY'];
    const p = new OpenAICompatProvider({ apiKeyEnv: 'OPENAI_API_KEY' });
    await p.chat({ model: 'haiku', prompt: 'test' });
    const headers = capturedRequest?.init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
    if (savedKey !== undefined) process.env['OPENAI_API_KEY'] = savedKey;
  });

  it('sends user prompt as user role message', async () => {
    mockFetchCapture(200, successBody());
    const p = new OpenAICompatProvider();
    await p.chat({ model: 'haiku', prompt: 'my prompt here' });
    const body = JSON.parse(capturedRequest?.init?.body as string);
    const userMsg = body.messages.find((m: { role: string }) => m.role === 'user');
    expect(userMsg?.content).toBe('my prompt here');
  });

  it('includes system message when systemPrompt is set', async () => {
    mockFetchCapture(200, successBody());
    const p = new OpenAICompatProvider();
    await p.chat({ model: 'haiku', prompt: 'q', systemPrompt: 'You are helpful' });
    const body = JSON.parse(capturedRequest?.init?.body as string);
    const sysMsg = body.messages.find((m: { role: string }) => m.role === 'system');
    expect(sysMsg?.content).toBe('You are helpful');
  });

  it('omits system message when systemPrompt is not set', async () => {
    mockFetchCapture(200, successBody());
    const p = new OpenAICompatProvider();
    await p.chat({ model: 'haiku', prompt: 'q' });
    const body = JSON.parse(capturedRequest?.init?.body as string);
    const sysMsg = body.messages.find((m: { role: string }) => m.role === 'system');
    expect(sysMsg).toBeUndefined();
  });

  it('sends temperature=0 and max_tokens=4096', async () => {
    mockFetchCapture(200, successBody());
    const p = new OpenAICompatProvider();
    await p.chat({ model: 'haiku', prompt: 'test' });
    const body = JSON.parse(capturedRequest?.init?.body as string);
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(4096);
  });
});

// ─────────────────────────────────────────────
// Model alias mapping
// ─────────────────────────────────────────────

describe('OpenAICompatProvider — model alias mapping', () => {
  it('maps haiku → gpt-4o-mini by default', async () => {
    mockFetchCapture(200, successBody());
    const p = new OpenAICompatProvider();
    await p.chat({ model: 'haiku', prompt: 'x' });
    const body = JSON.parse(capturedRequest?.init?.body as string);
    expect(body.model).toBe('gpt-4o-mini');
  });

  it('maps sonnet → gpt-4o by default', async () => {
    mockFetchCapture(200, successBody());
    const p = new OpenAICompatProvider();
    await p.chat({ model: 'sonnet', prompt: 'x' });
    const body = JSON.parse(capturedRequest?.init?.body as string);
    expect(body.model).toBe('gpt-4o');
  });

  it('applies modelAliasOverrides for haiku', async () => {
    mockFetchCapture(200, successBody());
    const p = new OpenAICompatProvider({ modelAliasOverrides: { haiku: 'gpt-3.5-turbo' } });
    await p.chat({ model: 'haiku', prompt: 'x' });
    const body = JSON.parse(capturedRequest?.init?.body as string);
    expect(body.model).toBe('gpt-3.5-turbo');
  });
});

// ─────────────────────────────────────────────
// Error handling
// ─────────────────────────────────────────────

describe('OpenAICompatProvider — error handling', () => {
  it('throws LlmError with ERR_CC_FAILED on HTTP 401', async () => {
    mockFetch(401, 'Unauthorized');
    const p = new OpenAICompatProvider();
    let caught: unknown;
    try { await p.chat({ model: 'haiku', prompt: 'test' }); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(LlmError);
    expect((caught as LlmError).code).toBe(ErrCode.ERR_CC_FAILED);
  });

  it('throws LlmError with ERR_CC_FAILED on HTTP 500', async () => {
    mockFetch(500, 'Internal Server Error');
    const p = new OpenAICompatProvider();
    let caught: unknown;
    try { await p.chat({ model: 'haiku', prompt: 'test' }); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(LlmError);
    expect((caught as LlmError).code).toBe(ErrCode.ERR_CC_FAILED);
  });

  it('throws LlmError with ERR_CC_OUTPUT_INVALID when response has no choices', async () => {
    mockFetch(200, {});
    const p = new OpenAICompatProvider();
    let caught: unknown;
    try { await p.chat({ model: 'haiku', prompt: 'test' }); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(LlmError);
    expect((caught as LlmError).code).toBe(ErrCode.ERR_CC_OUTPUT_INVALID);
  });

  it('error message does NOT contain the API key', async () => {
    mockFetch(401, 'Unauthorized');
    process.env['OPENAI_API_KEY'] = 'sk-supersecret-key';
    const p = new OpenAICompatProvider({ apiKeyEnv: 'OPENAI_API_KEY' });
    let caught: unknown;
    try { await p.chat({ model: 'haiku', prompt: 'test' }); } catch (e) { caught = e; }
    const msg = String(caught);
    expect(msg).not.toContain('sk-supersecret-key');
    delete process.env['OPENAI_API_KEY'];
  });

  it('throws LlmError when fetch itself throws (network error)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('ECONNREFUSED')));
    const p = new OpenAICompatProvider();
    let caught: unknown;
    try { await p.chat({ model: 'haiku', prompt: 'test' }); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(LlmError);
    expect((caught as LlmError).code).toBe(ErrCode.ERR_CC_FAILED);
  });
});

// ─────────────────────────────────────────────
// Default base URL
// ─────────────────────────────────────────────

describe('OpenAICompatProvider — defaults', () => {
  it('defaults baseURL to https://api.openai.com/v1', async () => {
    mockFetchCapture(200, successBody());
    const p = new OpenAICompatProvider();
    await p.chat({ model: 'haiku', prompt: 'x' });
    expect(capturedRequest?.url).toContain('api.openai.com');
  });

  it('strips trailing slash from baseURL', async () => {
    mockFetchCapture(200, successBody());
    const p = new OpenAICompatProvider({ baseURL: 'https://custom.api/v1/' });
    await p.chat({ model: 'haiku', prompt: 'x' });
    expect(capturedRequest?.url).toBe('https://custom.api/v1/chat/completions');
  });
});
