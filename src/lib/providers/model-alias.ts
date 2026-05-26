/**
 * src/lib/providers/model-alias.ts
 * Maps canonical aliases ('haiku' | 'sonnet' | 'opus') to provider-specific model IDs.
 */

import type { ClaudeModel } from './types.js';

export type ModelAliasMap = Record<ClaudeModel, string>;

/** Default model IDs for the claude-subprocess provider. */
export const CLAUDE_SUBPROCESS_DEFAULTS: ModelAliasMap = {
  haiku:  'claude-haiku-4-5',
  sonnet: 'claude-sonnet-4-6',
  opus:   'claude-opus-4-7',
};

/** Default model IDs for the openai-compat provider (sensible defaults). */
export const OPENAI_COMPAT_DEFAULTS: ModelAliasMap = {
  haiku:  'gpt-4o-mini',
  sonnet: 'gpt-4o',
  opus:   'gpt-4o',
};

/** Default model IDs for the MiniMax provider. */
export const MINIMAX_DEFAULTS: ModelAliasMap = {
  haiku:  'abab6.5s-chat',
  sonnet: 'MiniMax-Text-01',
  opus:   'MiniMax-M1',
};

/**
 * Resolve a canonical model alias to a provider-specific ID.
 * If `overrides` contains the alias, that wins. Otherwise falls back to `defaults`.
 */
export function resolveModelId(
  alias: ClaudeModel,
  defaults: ModelAliasMap,
  overrides?: Partial<ModelAliasMap>,
): string {
  return overrides?.[alias] ?? defaults[alias];
}
