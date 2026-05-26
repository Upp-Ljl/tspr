/**
 * src/report/ccSuggestFix.ts
 *
 * Calls the cc subprocess (via CcClientHandle.invoke) to get a suggested patch
 * and confidence rating for a given failure.
 *
 * B-4-2:  suggestedPatch absent when confidence < 0.7
 * B-4-13: confidence in [0, 1]
 * B-4-14: confidence = 0 when cc throws, times out, or returns unparseable output
 * B-4-15: relatedFiles always an array
 * B-4-24: confidence = rawScore / 10; non-integer raw scores accepted
 */

import type { CcClientHandle, FixRegion } from "../types/report.js";
import type { CcPatchResult } from "./types.js";

const CC_TIMEOUT_MS = 60_000; // 60 s default

function buildPrompt(opts: {
  testFile: string;
  testName: string;
  errorMessage: string;
  stack: string;
  fixRegion?: FixRegion;
  regionContents?: string;
}): string {
  const { testFile, testName, errorMessage, stack, fixRegion, regionContents } = opts;

  const regionSection =
    fixRegion && regionContents
      ? `\n## Code region (likely fix site)\nFile: ${fixRegion.file}, lines ${fixRegion.lineStart}–${fixRegion.lineEnd}:\n${regionContents}\n`
      : "";

  return [
    "You are a code-repair assistant. A test failed. Analyse the failure and propose a minimal fix.",
    "",
    "## Failing test",
    `File: ${testFile}`,
    `Name: ${testName}`,
    `Error: ${errorMessage}`,
    "Stack:",
    stack,
    regionSection,
    "## Task",
    "1. Propose a unified diff (--- a/... +++ b/... format) that fixes this test.",
    "2. List any other files you think need changing: RELATED_FILES:<comma-separated project-relative paths>",
    "3. On the last line, output EXACTLY: CONFIDENCE:<n> where n is 0-10 (integer, your certainty this patch fixes the test).",
    "",
    "Output only the diff block, the RELATED_FILES line, and the CONFIDENCE line. No prose.",
  ].join("\n");
}

function parseConfidence(raw: number | string | null | undefined): number {
  if (raw === null || raw === undefined) return 0;
  const n = typeof raw === "string" ? parseFloat(raw) : Number(raw);
  if (!isFinite(n) || isNaN(n)) return 0;
  // rawScore / 10 per B-4-24
  const normalized = n / 10;
  // Clamp to [0, 1]
  return Math.max(0, Math.min(1, normalized));
}

function parseCcResponse(output: string): {
  confidence: number;
  patch: string | undefined;
  relatedFiles: string[];
} {
  // Try to parse as JSON first (used by test stubs)
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(output) as Record<string, unknown>;
  } catch {
    // Not JSON — fall through to text parsing
  }

  if (parsed !== null && typeof parsed === "object") {
    const rawConfidence = parsed["confidence"] as number | null | undefined;
    const confidence = parseConfidence(rawConfidence);
    const patch =
      typeof parsed["patch"] === "string" && parsed["patch"].length > 0
        ? parsed["patch"]
        : undefined;
    const relatedFiles = Array.isArray(parsed["relatedFiles"])
      ? (parsed["relatedFiles"] as unknown[])
          .filter((f): f is string => typeof f === "string")
      : [];
    return { confidence, patch, relatedFiles };
  }

  // Text-based parsing — look for CONFIDENCE:<n> on the last line
  const lines = output.trim().split("\n");
  let confidence = 0;
  let confidenceLineIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^CONFIDENCE:(\d+(?:\.\d+)?)$/);
    if (m) {
      confidence = parseConfidence(parseFloat(m[1]));
      confidenceLineIndex = i;
      break;
    }
  }

  // Extract RELATED_FILES line
  let relatedFiles: string[] = [];
  let relatedLineIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^RELATED_FILES:(.*)$/);
    if (m) {
      const raw = m[1].trim();
      relatedFiles = raw
        ? raw.split(",").map((s) => s.trim()).filter(Boolean)
        : [];
      relatedLineIndex = i;
      break;
    }
  }

  // Everything before those sentinel lines is the patch
  const skipLines = new Set<number>();
  if (confidenceLineIndex >= 0) skipLines.add(confidenceLineIndex);
  if (relatedLineIndex >= 0) skipLines.add(relatedLineIndex);
  const patchLines = lines.filter((_, i) => !skipLines.has(i));
  const patchText = patchLines.join("\n").trim();
  const patch = patchText.length > 0 ? patchText : undefined;

  return { confidence, patch, relatedFiles };
}

export async function callCcForPatch(opts: {
  cc: CcClientHandle;
  testFile: string;
  testName: string;
  errorMessage: string;
  stack: string;
  fixRegion?: FixRegion;
}): Promise<CcPatchResult> {
  const startMs = Date.now();
  const prompt = buildPrompt(opts);

  let ccOutput: string;
  try {
    const invokePromise = opts.cc.invoke(prompt, {});

    // Apply internal timeout
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("cc invoke timeout")), CC_TIMEOUT_MS),
    );

    ccOutput = await Promise.race([invokePromise, timeoutPromise]);
  } catch {
    // cc threw or timed out — graceful degradation per B-4-14
    return {
      patch: undefined,
      confidence: 0,
      relatedFiles: [],
      costCcCalls: 1,
      costMs: Date.now() - startMs,
    };
  }

  const costMs = Date.now() - startMs;

  let parseResult: ReturnType<typeof parseCcResponse>;
  try {
    parseResult = parseCcResponse(ccOutput);
  } catch {
    return {
      patch: undefined,
      confidence: 0,
      relatedFiles: [],
      costCcCalls: 1,
      costMs,
    };
  }

  const { confidence, relatedFiles } = parseResult;
  let { patch } = parseResult;

  // B-4-2: omit suggestedPatch when confidence < 0.7
  if (confidence < 0.7) {
    patch = undefined;
  }

  return { patch, confidence, relatedFiles, costCcCalls: 1, costMs };
}
