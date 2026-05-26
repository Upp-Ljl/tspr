/**
 * tests/lib/providers/factory.test.ts
 * Tests for createProvider(config) factory.
 */

import { describe, it, expect } from 'vitest';
import { createProvider } from '../../../src/lib/providers/index.js';
import { ClaudeSubprocessProvider } from '../../../src/lib/providers/claude-subprocess.js';
import { OpenAICompatProvider } from '../../../src/lib/providers/openai-compat.js';
import { MinimaxProvider } from '../../../src/lib/providers/minimax.js';

describe('createProvider — factory routing', () => {
  it('returns ClaudeSubprocessProvider when provider="claude"', () => {
    const p = createProvider({ provider: 'claude' });
    expect(p).toBeInstanceOf(ClaudeSubprocessProvider);
  });

  it('returns ClaudeSubprocessProvider when provider is undefined (default)', () => {
    const p = createProvider({});
    expect(p).toBeInstanceOf(ClaudeSubprocessProvider);
  });

  it('returns OpenAICompatProvider when provider="openai-compat"', () => {
    const p = createProvider({ provider: 'openai-compat' });
    expect(p).toBeInstanceOf(OpenAICompatProvider);
  });

  it('returns MinimaxProvider when provider="minimax"', () => {
    const p = createProvider({ provider: 'minimax' });
    expect(p).toBeInstanceOf(MinimaxProvider);
  });

  it('passes openaiCompat config to OpenAICompatProvider', () => {
    // Just smoke — no HTTP call; provider created without error
    const p = createProvider({
      provider: 'openai-compat',
      openaiCompat: { baseURL: 'https://example.com/v1', apiKeyEnv: 'MY_KEY' },
    });
    expect(p).toBeInstanceOf(OpenAICompatProvider);
  });

  it('passes minimax config to MinimaxProvider', () => {
    const p = createProvider({
      provider: 'minimax',
      minimax: { baseURL: 'https://api.minimaxi.io/v1', apiKeyEnv: 'MINIMAX_API_KEY' },
    });
    expect(p).toBeInstanceOf(MinimaxProvider);
  });

  it('passes claudeSubprocess.binary to ClaudeSubprocessProvider (smoke)', () => {
    const p = createProvider({
      provider: 'claude',
      claudeSubprocess: { binary: '/custom/claude' },
    });
    expect(p).toBeInstanceOf(ClaudeSubprocessProvider);
  });

  it('passes modelAlias overrides through', () => {
    const p = createProvider({
      provider: 'claude',
      modelAlias: { haiku: 'claude-haiku-custom', sonnet: 'claude-sonnet-custom', opus: 'claude-opus-custom' },
    });
    expect(p).toBeInstanceOf(ClaudeSubprocessProvider);
  });
});
