/**
 * src/lib/providers/minimax.ts
 * MiniMax provider — composes OpenAICompatProvider with MiniMax-specific defaults.
 * Does NOT duplicate HTTP code.
 */

import { OpenAICompatProvider, type OpenAICompatConfig } from './openai-compat.js';
import { MINIMAX_DEFAULTS, type ModelAliasMap } from './model-alias.js';
import type { CcProvider } from './types.js';
import type { CcRunOptions, CcRunResult } from '../cc.js';

// ─────────────────────────────────────────────
// MiniMax config
// ─────────────────────────────────────────────

export type MinimaxRegion = 'cn' | 'intl';

export interface MinimaxConfig {
  /**
   * Region selector:
   *   'cn'   → https://api.minimaxi.chat/v1  (Chinese mainland)
   *   'intl' → https://api.minimaxi.io/v1   (international)
   * Overridden by explicit baseURL.
   */
  region?: MinimaxRegion;
  /**
   * Explicit base URL (overrides region). No trailing slash.
   */
  baseURL?: string;
  /**
   * Name of the env var holding the MiniMax API key.
   * Defaults to 'MINIMAX_API_KEY'.
   */
  apiKeyEnv?: string;
  /** Default per-call timeout in milliseconds. Default: 60_000. */
  defaultTimeoutMs?: number;
  /** Override model alias → model ID mapping. */
  modelAliasOverrides?: Partial<ModelAliasMap>;
}

const REGION_URLS: Record<MinimaxRegion, string> = {
  cn:   'https://api.minimaxi.chat/v1',
  intl: 'https://api.minimaxi.io/v1',
};

function resolveBaseURL(cfg: MinimaxConfig): string {
  if (cfg.baseURL) return cfg.baseURL;
  return REGION_URLS[cfg.region ?? 'cn'];
}

// ─────────────────────────────────────────────
// MiniMax provider (thin wrapper over openai-compat)
// ─────────────────────────────────────────────

export class MinimaxProvider implements CcProvider {
  private readonly inner: OpenAICompatProvider;

  constructor(cfg: MinimaxConfig = {}) {
    const openaiCfg: OpenAICompatConfig = {
      baseURL: resolveBaseURL(cfg),
      apiKeyEnv: cfg.apiKeyEnv ?? 'MINIMAX_API_KEY',
      defaultTimeoutMs: cfg.defaultTimeoutMs,
      modelAliasDefaults: MINIMAX_DEFAULTS,
      modelAliasOverrides: cfg.modelAliasOverrides,
    };
    this.inner = new OpenAICompatProvider(openaiCfg);
  }

  chat(opts: CcRunOptions): Promise<CcRunResult> {
    return this.inner.chat(opts);
  }
}
