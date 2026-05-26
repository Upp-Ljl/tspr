/**
 * src/report/testspriteCompat.ts
 *
 * Writes a TestSprite-compatible test_results.json to:
 *   {projectPath}/.tspr/test_results.json
 *
 * Triggered by TSPR_EMIT_TESTSPRITE_COMPAT=1 env var, or emitTestSpriteCompat: true option.
 * This is a side effect of buildReport, not the primary MCP return value.
 *
 * Schema mapping per spec §9.
 */

import { promises as fs } from "fs";
import path from "path";
import type { AutoPatchReport } from "../types/report.js";

interface TestSpriteFixRegion {
  file: string;
  line_start: number;
  line_end: number;
  why: string;
}

interface TestSpriteFailure {
  failing_test_id: string;
  test_name: string;
  test_file: string;
  error_message: string;
  stack_trace: string;
  dom_snapshot?: string;
  suggested_fix_region?: TestSpriteFixRegion;
  suggested_patch?: string;
  related_files: string[];
}

interface TestSpriteReport {
  run_id: string;
  total_tests: number;
  passed: number;
  failed: number;
  skipped: number;
  duration_ms: number;
  failures: TestSpriteFailure[];
}

function toTestSpriteReport(report: AutoPatchReport): TestSpriteReport {
  return {
    run_id: report.runId,
    total_tests: report.summary.total,
    passed: report.summary.passed,
    failed: report.summary.failed,
    skipped: report.summary.skipped,
    duration_ms: report.summary.durationMs,
    failures: report.failures.map((f) => {
      const failure: TestSpriteFailure = {
        failing_test_id: f.testId,
        test_name: f.testName,
        test_file: f.testFile,
        error_message: f.errorMessage,
        stack_trace: f.stack,
        related_files: f.relatedFiles,
      };

      if (f.domSnapshot !== undefined) {
        failure.dom_snapshot = f.domSnapshot;
      }

      if (f.suggestedFixRegion !== undefined) {
        failure.suggested_fix_region = {
          file: f.suggestedFixRegion.file,
          line_start: f.suggestedFixRegion.lineStart,
          line_end: f.suggestedFixRegion.lineEnd,
          why: f.suggestedFixRegion.why,
        };
      }

      if (f.suggestedPatch !== undefined) {
        failure.suggested_patch = f.suggestedPatch;
      }

      return failure;
    }),
  };
}

export async function writeTestSpriteCompat(
  report: AutoPatchReport,
  projectPath: string,
): Promise<void> {
  const dir = path.join(projectPath, ".tspr");
  const outputPath = path.join(dir, "test_results.json");

  await fs.mkdir(dir, { recursive: true });
  const tsReport = toTestSpriteReport(report);
  await fs.writeFile(outputPath, JSON.stringify(tsReport, null, 2), "utf8");
}

export function shouldEmitTestSpriteCompat(
  envVar?: string,
  optionFlag?: boolean,
): boolean {
  if (optionFlag === true) return true;
  const env = envVar ?? process.env["TSPR_EMIT_TESTSPRITE_COMPAT"];
  return env === "1" || env === "true";
}
