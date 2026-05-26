/**
 * src/report/schemas.ts
 *
 * Zod schemas derived from the public surface TypeScript interfaces.
 * Exported for use in tests and by callers who want runtime validation.
 */

import { z } from "zod";

export const ConsoleEntrySchema = z.object({
  level: z.enum(["log", "warn", "error"]),
  message: z.string().max(500),
  timestamp: z.string(),
});

export const NetworkErrorSchema = z.object({
  url: z.string(),
  method: z.string(),
  status: z.number().optional(),
  errorText: z.string().optional(),
});

export const HttpRequestSchema = z.object({
  method: z.string(),
  url: z.string(),
  headers: z.record(z.string()),
  body: z.string().max(10240).nullable().optional(),
});

export const HttpResponseSchema = z.object({
  status: z.number(),
  headers: z.record(z.string()),
  body: z.string().max(10240).optional(),
});

export const DbSnapshotSchema = z.object({
  tables: z.record(z.array(z.unknown())),
  capturedAt: z.string(),
});

export const FixRegionSchema = z.object({
  file: z.string(),
  lineStart: z.number().int().min(1),
  lineEnd: z.number().int().min(1),
  why: z.string().max(300),
});

export const FailureKindSchema = z.enum([
  "ASSERTION",
  "TIMEOUT",
  "EXCEPTION",
  "NAVIGATION",
  "NETWORK",
  "VISUAL",
]);

export const FailureRecordSchema = z.object({
  // Identity
  testId: z.string().length(12),
  testName: z.string(),
  testFile: z.string(),
  testType: z.enum(["frontend-e2e", "backend-integration"]),
  // Classification
  failureKind: FailureKindSchema,
  errorMessage: z.string().max(500),
  stack: z.string(),
  // Frontend-only (optional)
  domSnapshot: z.string().optional(),
  screenshotPath: z.string().optional(),
  consoleErrors: z.array(ConsoleEntrySchema).optional(),
  networkErrors: z.array(NetworkErrorSchema).optional(),
  lastUrl: z.string().optional(),
  lastAction: z.string().optional(),
  // Backend-only (optional)
  request: HttpRequestSchema.optional(),
  response: HttpResponseSchema.optional(),
  dbSnapshot: DbSnapshotSchema.optional(),
  // Fix guidance
  suggestedFixRegion: FixRegionSchema.optional(),
  suggestedPatch: z.string().optional(),
  relatedFiles: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  // Telemetry
  costCcCalls: z.number(),
  costMs: z.number(),
});

export const RunSummarySchema = z.object({
  total: z.number().int().min(0),
  passed: z.number().int().min(0),
  failed: z.number().int().min(0),
  skipped: z.number().int().min(0),
  durationMs: z.number().min(0),
});

export const AutoPatchReportSchema = z.object({
  runId: z.string().min(1),
  projectPath: z.string().min(1),
  generatedAt: z.string().regex(/Z$/),
  summary: RunSummarySchema,
  failures: z.array(FailureRecordSchema),
});

// Inferred types from schemas
export type ConsoleEntryZ = z.infer<typeof ConsoleEntrySchema>;
export type NetworkErrorZ = z.infer<typeof NetworkErrorSchema>;
export type HttpRequestZ = z.infer<typeof HttpRequestSchema>;
export type HttpResponseZ = z.infer<typeof HttpResponseSchema>;
export type DbSnapshotZ = z.infer<typeof DbSnapshotSchema>;
export type FixRegionZ = z.infer<typeof FixRegionSchema>;
export type FailureKindZ = z.infer<typeof FailureKindSchema>;
export type FailureRecordZ = z.infer<typeof FailureRecordSchema>;
export type RunSummaryZ = z.infer<typeof RunSummarySchema>;
export type AutoPatchReportZ = z.infer<typeof AutoPatchReportSchema>;
