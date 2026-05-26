/**
 * src/lib/cc.ts
 * Thin CcClient factory — delegates to the configured provider.
 *
 * Public interface is preserved exactly:
 *   createCcClient(config?) → CcClient
 *   CcClient.run(opts) → CcRunResult
 *
 * Legacy shape (claudeBin / claudeArgs / defaultTimeoutMs) still works
 * and routes to the claude-subprocess provider for backwards compat.
 */

export type ClaudeModel = 'haiku' | 'sonnet' | 'opus';

export interface CcRunOptions {
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

export interface CcRunResult {
  stdout: string;
  exitCode: number;
  durationMs: number;
  /** Cost in USD. Subprocess path: rough estimate. HTTP paths: computed from usage tokens. */
  costUsd: number;
  modelUsed: ClaudeModel;
}

export interface CcClient {
  run(opts: CcRunOptions): Promise<CcRunResult>;
}

// ─────────────────────────────────────────────
// Config (extends legacy shape with provider selector)
// ─────────────────────────────────────────────

export interface CcClientConfig {
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

  // ── openai-compat / minimax fields ──
  baseURL?: string;
  apiKeyEnv?: string;
  modelAliasOverrides?: Partial<Record<ClaudeModel, string>>;
}

// ─────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────

import { ClaudeSubprocessProvider } from './providers/claude-subprocess.js';
import { OpenAICompatProvider }     from './providers/openai-compat.js';
import { MinimaxProvider }          from './providers/minimax.js';
import type { CcProvider }          from './providers/types.js';

class CcClientImpl implements CcClient {
  constructor(private readonly provider: CcProvider) {}

  run(opts: CcRunOptions): Promise<CcRunResult> {
    return this.provider.chat(opts);
  }
}

/**
 * Create a new CcClient instance.
 *
 * With no arguments (or provider='claude') → claude CLI subprocess (legacy behavior).
 *
 * @param config Optional configuration.
 */
export function createCcClient(config?: CcClientConfig): CcClient {
  const provider = config?.provider ?? 'claude';

  let p: CcProvider;
  switch (provider) {
    case 'claude':
      p = new ClaudeSubprocessProvider({
        binary: config?.claudeBin,
        extraArgs: config?.claudeArgs,
        defaultTimeoutMs: config?.defaultTimeoutMs,
        modelAliasOverrides: config?.modelAliasOverrides,
      });
      break;

    case 'openai-compat':
      p = new OpenAICompatProvider({
        baseURL: config?.baseURL,
        apiKeyEnv: config?.apiKeyEnv,
        defaultTimeoutMs: config?.defaultTimeoutMs,
        modelAliasOverrides: config?.modelAliasOverrides,
      });
      break;

    case 'minimax':
      p = new MinimaxProvider({
        baseURL: config?.baseURL,
        apiKeyEnv: config?.apiKeyEnv,
        defaultTimeoutMs: config?.defaultTimeoutMs,
        modelAliasOverrides: config?.modelAliasOverrides,
      });
      break;

    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unknown provider: ${String(_exhaustive)}`);
    }
  }

  return new CcClientImpl(p);
}
