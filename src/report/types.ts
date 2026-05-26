/**
 * Internal TypeScript types for the report module.
 * Not exported as public surface.
 */

export interface ParsedFrame {
  file: string;       // project-relative or absolute path
  line: number;       // 1-indexed
  col?: number;
  raw: string;        // original frame text
}

export interface CcPatchResult {
  patch: string | undefined;      // undefined when confidence < 0.7
  confidence: number;             // [0, 1]
  relatedFiles: string[];
  costCcCalls: number;
  costMs: number;
}
