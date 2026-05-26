/**
 * src/lib/providers/index.ts
 * Provider factory: createProvider(config) → CcProvider
 */

export type { CcProvider } from './types.js';
export { ClaudeSubprocessProvider, type ClaudeSubprocessConfig } from './claude-subprocess.js';
export { OpenAICompatProvider, type OpenAICompatConfig } from './openai-compat.js';
export { MinimaxProvider, type MinimaxConfig, type MinimaxRegion } from './minimax.js';
export {
  CLAUDE_SUBPROCESS_DEFAULTS,
  OPENAI_COMPAT_DEFAULTS,
  MINIMAX_DEFAULTS,
  resolveModelId,
  type ModelAliasMap,
} from './model-alias.js';

import { ClaudeSubprocessProvider } from './claude-subprocess.js';
import { OpenAICompatProvider } from './openai-compat.js';
import { MinimaxProvider } from './minimax.js';
import type { CcProvider } from './types.js';
import type { LocalSpriteConfig } from '../config.js';

/**
 * Create the appropriate CcProvider from a resolved config object.
 * Defaults to claude-subprocess if no provider is set.
 */
export function createProvider(config: LocalSpriteConfig): CcProvider {
  const provider = config.provider ?? 'claude';

  switch (provider) {
    case 'claude':
      return new ClaudeSubprocessProvider({
        binary: config.claudeSubprocess?.binary,
        modelAliasOverrides: config.modelAlias,
      });

    case 'openai-compat':
      return new OpenAICompatProvider({
        baseURL: config.openaiCompat?.baseURL,
        apiKeyEnv: config.openaiCompat?.apiKeyEnv,
        modelAliasOverrides: config.modelAlias,
      });

    case 'minimax':
      return new MinimaxProvider({
        baseURL: config.minimax?.baseURL,
        apiKeyEnv: config.minimax?.apiKeyEnv,
        modelAliasOverrides: config.modelAlias,
      });

    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unknown provider: ${String(_exhaustive)}`);
    }
  }
}
