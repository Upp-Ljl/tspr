/**
 * src/report/sizeCap.ts
 *
 * Enforces the 500 KB total report size budget by dropping fields in priority order.
 *
 * B-4-16: Drop order:
 *   1. domSnapshot (all failures)
 *   2. networkErrors (all failures)
 *   3. dbSnapshot (all failures)
 *   4. consoleErrors (all failures)
 *   5. request.body (all failures)
 *   6. response.body (all failures)
 *   7. suggestedPatch (all failures)
 *   8. stack truncated to 2048 JS characters (string.length — NOT UTF-8 bytes; distinct from B-4-9)
 */

import type { AutoPatchReport } from "../types/report.js";

const MAX_BYTES = 500 * 1024;
const STACK_EMERGENCY_CHARS = 2048; // JS string.length units (B-4-16 step 8)

function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

type DropFn = (r: AutoPatchReport) => void;

const DROPS: DropFn[] = [
  // 1. domSnapshot
  (r) => r.failures.forEach((f) => { delete f.domSnapshot; }),
  // 2. networkErrors
  (r) => r.failures.forEach((f) => { delete f.networkErrors; }),
  // 3. dbSnapshot
  (r) => r.failures.forEach((f) => { delete f.dbSnapshot; }),
  // 4. consoleErrors
  (r) => r.failures.forEach((f) => { delete f.consoleErrors; }),
  // 5. request.body
  (r) => r.failures.forEach((f) => { if (f.request) { delete f.request.body; } }),
  // 6. response.body
  (r) => r.failures.forEach((f) => { if (f.response) { delete f.response.body; } }),
  // 7. suggestedPatch
  (r) => r.failures.forEach((f) => { delete f.suggestedPatch; }),
  // 8. stack truncated to 2048 JS characters (string.length; not UTF-8 bytes — see B-4-16 note)
  (r) =>
    r.failures.forEach((f) => {
      if (f.stack && f.stack.length > STACK_EMERGENCY_CHARS) {
        f.stack = f.stack.slice(0, STACK_EMERGENCY_CHARS) + "[truncated]";
      }
    }),
];

export function applySizeCap(report: AutoPatchReport): AutoPatchReport {
  let json = JSON.stringify(report);
  if (byteLength(json) <= MAX_BYTES) return report;

  for (const drop of DROPS) {
    drop(report);
    json = JSON.stringify(report);
    if (byteLength(json) <= MAX_BYTES) break;
  }

  // If still over — return as-is (soft cap; B-4-16 last paragraph)
  return report;
}
