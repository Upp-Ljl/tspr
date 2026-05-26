/**
 * src/report/index.ts
 * Public re-exports for the auto-patch report module.
 */

export { buildReport } from "./buildReport.js";
export type { BuildReportOptions } from "./buildReport.js";
export { writeTestSpriteCompat, shouldEmitTestSpriteCompat } from "./testspriteCompat.js";

// Re-export all public types
export type {
  AutoPatchReport,
  RunSummary,
  FailureRecord,
  FailureKind,
  ConsoleEntry,
  NetworkError,
  HttpRequest,
  HttpResponse,
  DbSnapshot,
  FixRegion,
  BuildReportInput,
  TestRunResult,
  RawFailure,
  SrcMapIndex,
  CcClientHandle,
} from "../types/report.js";
export { ReportError } from "../types/report.js";
