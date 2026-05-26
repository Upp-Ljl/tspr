/**
 * src/lib/providers/types.ts
 * CcProvider interface — all providers implement this.
 */

import type { ClaudeModel, CcRunOptions, CcRunResult } from '../cc.js';

export type { ClaudeModel };

/**
 * A CcProvider handles the actual transport for a cc.run() call.
 * The thin CcClient in cc.ts delegates here.
 */
export interface CcProvider {
  /**
   * Execute the model call and return a result.
   * Implementors should throw CcError on failure.
   */
  chat(opts: CcRunOptions): Promise<CcRunResult>;
}
