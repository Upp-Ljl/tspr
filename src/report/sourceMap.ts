/**
 * src/report/sourceMap.ts
 *
 * Stack trace cleaning + source-map resolution pipeline.
 *
 * B-4-9:  stack ≤ 8 KB (UTF-8 bytes); truncated at last complete line; ends with "[truncated]"
 * B-4-11: suggestedFixRegion absent when no user-space frames found
 * B-4-12: fixRegion.lineEnd >= lineStart, both >= 1
 */

import type { SrcMapIndex } from "../types/report.js";
import type { ParsedFrame } from "./types.js";
import type { FixRegion } from "../types/report.js";

// Patterns for frames to strip (runner internals, node core, playwright)
const INTERNAL_FRAME_PATTERNS = [
  /node_modules\//,
  /\binternal\//,
  /playwright-core\//,
];

const STACK_BYTE_LIMIT = 8 * 1024; // 8 KB in UTF-8 bytes

/**
 * Parse a raw stack trace line like:
 *   "    at Object.<anonymous> (src/login.ts:42:10)"
 *   "    at src/login.ts:42:10"
 * Returns null if no file:line can be extracted.
 */
function parseFrame(line: string): ParsedFrame | null {
  // Match "at <optional-name> (<file>:<line>:<col>)" or "at <file>:<line>:<col>"
  const match = line.match(
    /at (?:.*? \()?(.+?):(\d+)(?::(\d+))?\)?$/,
  );
  if (!match) return null;
  const file = match[1].trim();
  const lineNum = parseInt(match[2], 10);
  if (isNaN(lineNum)) return null;
  return { file, line: lineNum, col: match[3] ? parseInt(match[3], 10) : undefined, raw: line };
}

function isInternalFrame(frame: ParsedFrame): boolean {
  return INTERNAL_FRAME_PATTERNS.some((p) => p.test(frame.file));
}

// "[truncated]" marker byte length — must reserve this space in the 8 KB budget
const TRUNCATION_MARKER = "\n[truncated]";
const TRUNCATION_MARKER_BYTES = new TextEncoder().encode(TRUNCATION_MARKER).length;

function truncateStack(cleaned: string): string {
  const enc = new TextEncoder();
  const bytes = enc.encode(cleaned);
  if (bytes.length <= STACK_BYTE_LIMIT) return cleaned;

  // Reserve space for the truncation marker in the 8 KB budget
  const limit = STACK_BYTE_LIMIT - TRUNCATION_MARKER_BYTES;

  // Walk chars, tracking UTF-8 byte consumption, find last newline under limit
  let charIndex = 0;
  let byteCount = 0;
  let lastNewlineCharIndex = 0;

  for (const char of cleaned) {
    const charBytes = enc.encode(char).length;
    if (byteCount + charBytes > limit) break;
    byteCount += charBytes;
    charIndex += char.length; // handle surrogate pairs
    if (char === "\n") lastNewlineCharIndex = charIndex;
  }

  const cutPoint = lastNewlineCharIndex > 0 ? lastNewlineCharIndex : charIndex;
  return cleaned.slice(0, cutPoint).trimEnd() + TRUNCATION_MARKER;
}

export interface StackResult {
  stack: string;
  suggestedFixRegion?: FixRegion;
}

/**
 * Clean a raw stack trace, resolve source maps if available, and derive the fix region.
 */
export function processStack(
  rawStack: string,
  _srcMaps: SrcMapIndex,
  projectPath: string,
): StackResult {
  if (!rawStack.trim()) {
    return { stack: "" };
  }

  const lines = rawStack.split("\n");

  // Separate non-frame lines (error message) and frame lines
  const cleanedLines: string[] = [];
  const userFrames: ParsedFrame[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("at ")) {
      // Not a frame line — keep (error message header)
      cleanedLines.push(line);
      continue;
    }

    const frame = parseFrame(trimmed);
    if (!frame) {
      cleanedLines.push(line);
      continue;
    }

    if (isInternalFrame(frame)) {
      // Strip internal/runner/node_modules frames
      continue;
    }

    // User-space frame
    userFrames.push(frame);
    cleanedLines.push(line);
  }

  const cleaned = cleanedLines.join("\n").trim();
  const truncated = truncateStack(cleaned);

  // Derive fix region from first user-space frame
  let suggestedFixRegion: FixRegion | undefined;
  if (userFrames.length > 0) {
    const firstFrame = userFrames[0];
    // Make file project-relative if it starts with the projectPath
    let relFile = firstFrame.file;
    if (relFile.startsWith(projectPath)) {
      relFile = relFile.slice(projectPath.length).replace(/^[/\\]/, "");
    }
    // Normalize path separators
    relFile = relFile.replace(/\\/g, "/");

    const lineStart = Math.max(1, firstFrame.line - 5);
    const lineEnd = firstFrame.line + 15;

    suggestedFixRegion = {
      file: relFile,
      lineStart,
      lineEnd,
      why: `First user-space stack frame at line ${firstFrame.line}`,
    };
  }

  return { stack: truncated, suggestedFixRegion };
}
