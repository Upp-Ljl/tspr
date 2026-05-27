/**
 * src/lib/cc.ts
 * Thin LlmClient factory — delegates to the configured provider.
 *
 * Public interface is preserved exactly:
 *   createLlmClient(config?) → LlmClient
 *   LlmClient.run(opts) → LlmRunResult
 *
 * Legacy shape (claudeBin / claudeArgs / defaultTimeoutMs) still works
 * and routes to the claude-subprocess provider for backwards compat.
 */

export type ClaudeModel = 'haiku' | 'sonnet' | 'opus';

export interface LlmRunOptions {
  model: ClaudeModel;
  prompt: string;
  /** Milliseconds before the subprocess is killed / HTTP request times out. Default: 60_000. */
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  systemPrompt?: string;
  /**
   * Extra environment variables merged into the subprocess environment.
   * Used in tests to pass control variables to fake claude scripts.
   * Ignored by HTTP providers.
   */
  _env?: Record<string, string>;
}

export interface LlmRunResult {
  stdout: string;
  exitCode: number;
  durationMs: number;
  /** Cost in USD. Subprocess path: rough estimate. HTTP paths: computed from usage tokens. */
  costUsd: number;
  modelUsed: ClaudeModel;
}

export interface LlmClient {
  run(opts: LlmRunOptions): Promise<LlmRunResult>;
}

// ─────────────────────────────────────────────
// Config (extends legacy shape with provider selector)
// ─────────────────────────────────────────────

export interface LlmClientConfig {
  /**
   * Which provider to use.
   * Default: 'claude' (subprocess — backwards compat).
   */
  provider?: 'claude' | 'openai-compat' | 'minimax';

  // ── Legacy claude-subprocess fields (still honored when provider='claude') ──
  /** Path to the `claude` binary. Defaults to 'claude'. */
  claudeBin?: string;
  /** Extra leading arguments inserted before --model. */
  claudeArgs?: string[];
  /** Default subprocess timeout in milliseconds. Default: 60_000. */
  defaultTimeoutMs?: number;

  // ── Flat openai-compat / minimax fields (legacy DI shape) ──
  baseURL?: string;
  apiKeyEnv?: string;
  modelAliasOverrides?: Partial<Record<ClaudeModel, string>>;

  // ── Nested form (matches loadConfig() output from ~/.tspr/config.json) ──
  openaiCompat?: { baseURL?: string; apiKeyEnv?: string };
  minimax?:      { baseURL?: string; apiKeyEnv?: string };
  claudeSubprocess?: { binary?: string };
  modelAlias?: Partial<Record<ClaudeModel, string>>;
}

// ─────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────

import { ClaudeSubprocessProvider } from './providers/claude-subprocess.js';
import { OpenAICompatProvider }     from './providers/openai-compat.js';
import { MinimaxProvider }          from './providers/minimax.js';
import type { LlmProvider }          from './providers/types.js';

class LlmClientImpl implements LlmClient {
  constructor(private readonly provider: LlmProvider) {}

  run(opts: LlmRunOptions): Promise<LlmRunResult> {
    return this.provider.chat(opts);
  }
}

/**
 * Create a new LlmClient instance.
 *
 * With no arguments (or provider='claude') → claude CLI subprocess (legacy behavior).
 *
 * @param config Optional configuration.
 */
export function createLlmClient(config?: LlmClientConfig): LlmClient {
  const provider = config?.provider ?? 'claude';

  let p: LlmProvider;
  switch (provider) {
    case 'claude':
      p = new ClaudeSubprocessProvider({
        binary: config?.claudeBin ?? config?.claudeSubprocess?.binary,
        extraArgs: config?.claudeArgs,
        defaultTimeoutMs: config?.defaultTimeoutMs,
        modelAliasOverrides: config?.modelAliasOverrides ?? config?.modelAlias,
      });
      break;

    case 'openai-compat':
      p = new OpenAICompatProvider({
        baseURL:   config?.baseURL   ?? config?.openaiCompat?.baseURL,
        apiKeyEnv: config?.apiKeyEnv ?? config?.openaiCompat?.apiKeyEnv,
        defaultTimeoutMs: config?.defaultTimeoutMs,
        modelAliasOverrides: config?.modelAliasOverrides ?? config?.modelAlias,
      });
      break;

    case 'minimax':
      p = new MinimaxProvider({
        baseURL:   config?.baseURL   ?? config?.minimax?.baseURL,
        apiKeyEnv: config?.apiKeyEnv ?? config?.minimax?.apiKeyEnv,
        defaultTimeoutMs: config?.defaultTimeoutMs,
        modelAliasOverrides: config?.modelAliasOverrides ?? config?.modelAlias,
      });
      break;

    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unknown provider: ${String(_exhaustive)}`);
    }
  }

  return new LlmClientImpl(p);
}
