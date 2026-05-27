/**
 * src/lib/providers/types.ts
 * LlmProvider interface — all providers implement this.
 */

import type { ClaudeModel, LlmRunOptions, LlmRunResult } from '../cc.js';

export type { ClaudeModel };

/**
 * A LlmProvider handles the actual transport for a cc.run() call.
 * The thin LlmClient in cc.ts delegates here.
 */
export interface LlmProvider {
  /**
   * Execute the model call and return a result.
   * Implementors should throw LlmError on failure.
   */
  chat(opts: LlmRunOptions): Promise<LlmRunResult>;
}
