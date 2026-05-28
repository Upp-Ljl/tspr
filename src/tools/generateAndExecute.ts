/**
 * Tool 6: tspr_generate_code_and_execute
 *
 * Reads test plan, generates test code via cc, runs in Docker, returns structured results.
 * Returns a `summary` markdown field that cc can relay verbatim to the user.
 * Returns a `_timeline` array with per-step timing + LLM trace for the transparency panel.
 */
import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition, ToolResult, ServerContext } from '../types/mcp.js';
import { createSandbox, SandboxError } from '../sandbox/index.js';
import { captureFailureScreenshot, inferTestUrl } from '../sandbox/screenshot.js';
import { renderHtmlReport } from '../report/html-renderer.js';
import { computeStableIssueId } from '../dashboard/issues.js';
import { computeSeverity } from '../lib/severity.js';
import { resolveTitle } from '../lib/scenario-title.js';

export const generateAndExecuteInputSchema = z.object({
  projectName: z.string(),
  projectPath: z.string(),
  testIds: z.array(z.string()).default([]),
  additionalInstruction: z.string().default(''),
});

type GenerateAndExecuteInput = z.infer<typeof generateAndExecuteInputSchema>;

/** One step in the tool-6 execution timeline (transparency data) */
export interface TimelineStep {
  step: 'plan-load' | 'cc-generate' | 'sandbox-exec' | 'parse-results' | 'write-artifacts';
  start: number;        // ms since epoch (Date.now())
  durationMs: number;
  modelUsed?: string;   // e.g. 'claude-sonnet-4-6'
  costUsd?: number;     // estimated; 0 if unknown
  promptChars?: number;
  responseChars?: number;
}

/**
 * One event in a per-scenario chronological replay timeline.
 * Append-only; generated at parse time from vitest output and test title heuristics.
 */
export interface ScenarioReplayEvent {
  /** ms since scenario start (0 = start of scenario) */
  ts: number;
  kind: 'http-request' | 'http-response' | 'console' | 'assertion' | 'navigation';
  /** Human-readable one-liner — rendered in the timeline UI */
  detail: string;
  /** Optional extras for drill-down */
  data?: Record<string, unknown>;
}

export interface ExecuteResult {
  status: 'ok' | 'partial' | 'all-failed';
  outputPath: string;
  reportPath: string;
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
  warnings: string[];
  failures: Array<{
    testId: string;
    /** Stable 16-char hex issue ID (hash of testId + projectPath) */
    issueId: string;
    title: string;
    stack: string;
    domSnapshot?: string;
    responseBody?: unknown;
    suggestedFixRegion: {
      file: string;
      lineStart: number;
      lineEnd: number;
      why: string;
    };
    suggestedPatch?: string;
    /** Base64-encoded PNG screenshot of the failing page (best-effort; null if unavailable) */
    screenshotBase64?: string | null;
    /** Chronological replay timeline for this failure */
    events?: ScenarioReplayEvent[];
  }>;
  /**
   * Pre-formatted markdown summary suitable for direct relay to user via cc chat.
   * cc should relay this verbatim — no need to summarize the raw JSON.
   */
  summary: string;
  /**
   * Per-step timing + LLM trace. Underscore prefix = transparency metadata.
   * May be omitted in compact mode by the caller.
   */
  _timeline: TimelineStep[];
}

// Sandbox interface for Docker (mock in tests, real in Round 5)
export interface DockerSandbox {
  run(opts: {
    image: string;
    binds: string[];
    cmd: string[];
    labels?: Record<string, string>;
    timeoutMs?: number;
  }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

function computeStatus(passed: number, failed: number, skipped: number): 'ok' | 'partial' | 'all-failed' {
  if (failed === 0) return 'ok';
  if (passed > 0 && failed > 0) return 'partial';
  return 'all-failed';
}

// ─── Summary builder ──────────────────────────────────────────────────────────

/** Shape passed to buildSummary — one entry per scenario (pass or fail). */
export interface SummaryScenario {
  id: string;
  title: string;
  type?: string | null;
  passed: boolean;
  /** Present only when passed=false */
  failure?: {
    issueId: string;
    file: string;
    lineStart: number;
    why: string;
    suggestedPatch?: string;
  };
}

/**
 * Build the TestSprite-style markdown summary for cc chat relay.
 *
 * Format:
 *   **tspr** ran N scenarios against `projectName` in Xs.
 *
 *   P pass · F fail · $cost · model · runId `shortId`
 *
 *   **Scenarios**
 *   - ✅ `[Major]` scenario title
 *   - ❌ `[Critical]` failing scenario title
 *
 *   **Failures**
 *   ❌ **issue-XXXX** · `[Critical]` scenario title
 *   File: `relative/path:line`
 *   Fix: one-line why
 *   → Apply: `tspr apply-fix XXXX` (or say "apply tspr fix XXXX")
 *
 *   [Local report](file:///.../report.html) · [Dashboard](http://localhost:7654)
 */
export function buildSummary(
  projectName: string,
  totalTests: number,
  passed: number,
  failed: number,
  skipped: number,
  failures: ExecuteResult['failures'],
  warnings: string[],
  modelId: string,
  durationMs: number,
  runId: string,
  reportPath: string,
  allScenarios?: Array<{ id: string; type?: string | null; title?: string | null; endpoint?: string | null; description?: string | null }>,
): string {
  const lines: string[] = [];

  // ── Header line ─────────────────────────────────────────────────────────────
  const durationLabel = durationMs < 1000
    ? `${durationMs}ms`
    : `${(durationMs / 1000).toFixed(0)}s`;
  lines.push(`**tspr** ran ${totalTests} scenario${totalTests !== 1 ? 's' : ''} against \`${projectName}\` in ${durationLabel}.`);
  lines.push('');

  // ── Stats line ───────────────────────────────────────────────────────────────
  const modelLabel = modelId || 'unknown';
  const shortRunId = runId.slice(0, 8);
  const skipPart = skipped > 0 ? ` · ${skipped} skipped` : '';
  lines.push(`${passed} pass · ${failed} fail${skipPart} · ${modelLabel} · runId \`${shortRunId}\``);

  // ── Warnings ─────────────────────────────────────────────────────────────────
  if (warnings.length > 0) {
    lines.push('');
    for (const w of warnings) {
      lines.push(`> ⚠️ ${w}`);
    }
  }

  // ── Scenarios list ───────────────────────────────────────────────────────────
  // Build a map from testId → failure for O(1) lookup
  const failureByTestId = new Map(failures.map((f) => [f.testId, f]));

  if (allScenarios && allScenarios.length > 0) {
    lines.push('');
    lines.push('**Scenarios**');

    for (const scenario of allScenarios) {
      const failure = failureByTestId.get(scenario.id);
      const isPassed = !failure;
      const icon = isPassed ? '✅' : '❌';
      const badge = computeSeverity({ type: scenario.type });
      // Prefer scenario.title, then endpoint/description
      const displayTitle =
        scenario.title ||
        scenario.endpoint ||
        scenario.description ||
        scenario.id;

      lines.push(`- ${icon} \`${badge}\` ${displayTitle}`);
    }
  } else if (failures.length > 0 || passed > 0) {
    // Fallback: only show failures in scenario list (when allScenarios not available)
    lines.push('');
    lines.push('**Scenarios**');
    // Show passing count as a placeholder row
    if (passed > 0) {
      lines.push(`- ✅ ${passed} scenario${passed !== 1 ? 's' : ''} passed`);
    }
    for (const f of failures) {
      const badge = computeSeverity({});
      const displayTitle = f.title.length > 80 ? f.title.slice(0, 77) + '…' : f.title;
      lines.push(`- ❌ \`${badge}\` ${displayTitle}`);
    }
  }

  // ── Failures detail ──────────────────────────────────────────────────────────
  if (failures.length > 0) {
    lines.push('');
    lines.push('**Failures**');
    lines.push('');

    const displayCount = Math.min(failures.length, 5);
    for (let i = 0; i < displayCount; i++) {
      const f = failures[i];
      // Match back to scenario for severity (use failures's testId)
      const scenario = allScenarios?.find((s) => s.id === f.testId);
      const badge = computeSeverity({ type: scenario?.type });
      const shortIssueId = f.issueId.slice(0, 4);
      const displayTitle = resolveTitle(f.title, allScenarios ?? null);
      const truncTitle = displayTitle.length > 80 ? displayTitle.slice(0, 77) + '…' : displayTitle;

      lines.push(`❌ **issue-${shortIssueId}** · \`${badge}\` ${truncTitle}`);

      const fix = f.suggestedFixRegion;
      if (fix) {
        // Relativize the path — strip internal container paths, use short relative form
        const relativePath = relativizeFilePath(fix.file);
        lines.push(`File: \`${relativePath}:${fix.lineStart}\``);

        if (fix.why) {
          const why = fix.why.length > 120 ? fix.why.slice(0, 117) + '…' : fix.why;
          lines.push(`Fix: ${why}`);
        }
      }

      lines.push(`→ Apply: \`tspr apply-fix ${f.issueId.slice(0, 4)}\` (or say "apply tspr fix ${f.issueId.slice(0, 4)}")`);


      lines.push('');
    }

    if (failures.length > displayCount) {
      lines.push(`_… and ${failures.length - displayCount} more — see dashboard for full list._`);
      lines.push('');
    }
  }

  // ── Footer ───────────────────────────────────────────────────────────────────
  // Use localhost dashboard URL only (no file:// links — not clickable in terminal)
  const reportFileUrl = `file:///${reportPath.replace(/\\/g, '/')}`;
  lines.push(`[Local report](${reportFileUrl}) · [Dashboard](http://localhost:7654)`);

  return lines.join('\n');
}

/**
 * Relativize a file path for human display.
 * Strips internal tspr-runtime container paths and Windows absolute path prefixes.
 * Returns a short, readable form.
 */
export function relativizeFilePath(file: string): string {
  // Normalize backslashes to forward slashes
  const normalized = file.replace(/\\/g, '/');

  // Strip known container-internal prefixes
  // e.g. "../../tspr-runtime/tests/meme-weather.spec.ts" → "tspr-generated/meme-weather.spec.ts"
  const containerMatch = normalized.match(/tspr-runtime\/tests\/(.+)$/);
  if (containerMatch) {
    return `tspr-generated/${containerMatch[1]}`;
  }

  // Strip leading ../.. traversals
  const traversalStripped = normalized.replace(/^(\.\.\/)+/, '');
  if (traversalStripped !== normalized) {
    return traversalStripped;
  }

  // Strip Windows absolute path prefix (e.g. C:/Users/.../project/src/...)
  // Keep the portion after the last known project-root marker
  const srcMatch = normalized.match(/(?:src|app|lib|pages|routes|api)\/.+$/);
  if (srcMatch) {
    return srcMatch[0];
  }

  // Return as-is if nothing matched (already short)
  return normalized;
}

// ─── Replay event builder ──────────────────────────────────────────────────────

/**
 * Build a ScenarioReplayEvent[] for a failed test.
 *
 * Strategy (fixture-first, no Playwright needed):
 *  1. If the test title implies an HTTP endpoint (e.g. "GET /api/memes returns 200"),
 *     emit one http-request + http-response pair.
 *  2. If vitest console output contains matching lines, emit console events.
 *  3. Always emit one assertion event from the failureMessage.
 *
 * Returns at minimum: one assertion event.
 */
export function buildReplayEvents(
  testTitle: string,
  failureMessages: string[],
  consoleOutput?: string,
): ScenarioReplayEvent[] {
  const events: ScenarioReplayEvent[] = [];
  let ts = 0;

  // 1. HTTP request/response pair — inferred from test title
  // Match patterns like "GET /api/foo", "POST /users 201", "should return 200 for /api/x"
  const httpMatch = testTitle.match(
    /\b(GET|POST|PUT|PATCH|DELETE|HEAD)\s+(\/[^\s)"']*)/i,
  );
  if (httpMatch) {
    const method = httpMatch[1].toUpperCase();
    const urlPath = httpMatch[2];
    // Try to extract status code from title (e.g. "returns 200", "status 404")
    const statusMatch = testTitle.match(/\b(\d{3})\b/);
    const expectedStatus = statusMatch ? parseInt(statusMatch[1], 10) : null;

    events.push({
      ts,
      kind: 'http-request',
      detail: `${method} ${urlPath}`,
      data: { method, path: urlPath },
    });
    ts += 5; // minimal synthetic ms offset

    // Response: if we have a failure message with status info, show "got N"
    const gotStatusMatch = (failureMessages.join('\n')).match(/\bexpected\s+(\d{3})|got\s+(\d{3})|status[:\s]+(\d{3})/i);
    const actualStatus = gotStatusMatch
      ? parseInt(gotStatusMatch[1] ?? gotStatusMatch[2] ?? gotStatusMatch[3], 10)
      : null;

    const responseDetail = expectedStatus && actualStatus && actualStatus !== expectedStatus
      ? `${method} ${urlPath} → ${actualStatus} (expected ${expectedStatus})`
      : actualStatus
        ? `${method} ${urlPath} → ${actualStatus}`
        : `${method} ${urlPath} → (failed)`;

    events.push({
      ts,
      kind: 'http-response',
      detail: responseDetail,
      data: { expectedStatus, actualStatus },
    });
    ts += 5;
  }

  // 2. Console events — look for matching lines in vitest console output
  if (consoleOutput) {
    const lines = consoleOutput.split('\n');
    for (const line of lines) {
      const consoleLevelMatch = line.match(/\b(console\.(log|warn|error|info)):\s*(.*)/i);
      if (consoleLevelMatch) {
        const msg = consoleLevelMatch[3].slice(0, 200);
        events.push({
          ts,
          kind: 'console',
          detail: `${consoleLevelMatch[1]}: ${msg}`,
          data: { level: consoleLevelMatch[2] },
        });
        ts += 1;
      }
    }
  }

  // 3. Assertion event — always emit from failureMessage
  const failureText = failureMessages.join('\n').slice(0, 500);
  if (failureText) {
    // Extract the first meaningful assertion line (skip stack frames)
    const lines = failureText.split('\n').filter((l) => l.trim() && !l.trim().startsWith('at '));
    const assertionLine = lines[0]?.slice(0, 200) || failureText.slice(0, 200);
    events.push({
      ts,
      kind: 'assertion',
      detail: assertionLine,
      data: { fullMessage: failureText },
    });
  }

  return events;
}

// ─── runExecute ───────────────────────────────────────────────────────────────

export async function runExecute(
  input: GenerateAndExecuteInput,
  ctx: ServerContext,
  sandbox?: DockerSandbox,
): Promise<ExecuteResult> {
  const { projectPath, projectName, testIds, additionalInstruction } = input;
  const tsprDir = path.join(projectPath, '.tspr');
  const _timeline: TimelineStep[] = [];

  // ── Step: plan-load ───────────────────────────────────────────────────────
  const planLoadStart = Date.now();

  // Load test plans
  const frontendPlanPath = path.join(tsprDir, 'frontend_test_plan.json');
  const backendPlanPath = path.join(tsprDir, 'backend_test_plan.json');

  let allScenarios: Array<{ id: string; type?: string; title?: string; endpoint?: string; description?: string }> = [];

  const hasFrontend = fs.existsSync(frontendPlanPath);
  const hasBackend = fs.existsSync(backendPlanPath);

  if (!hasFrontend && !hasBackend) {
    throw new McpError(
      ErrorCode.InternalError,
      'ERR_NO_TEST_PLAN',
      {
        code: 'ERR_NO_TEST_PLAN',
        projectPath,
        suggestion: 'Run tspr_generate_frontend_test_plan or tspr_generate_backend_test_plan first.',
      },
    );
  }

  if (hasFrontend) {
    try {
      const plan = JSON.parse(fs.readFileSync(frontendPlanPath, 'utf-8')) as {
        scenarios: typeof allScenarios;
      };
      allScenarios.push(...(plan.scenarios || []));
    } catch { /* ignore parse errors */ }
  }
  if (hasBackend) {
    try {
      const plan = JSON.parse(fs.readFileSync(backendPlanPath, 'utf-8')) as {
        scenarios: typeof allScenarios;
      };
      allScenarios.push(...(plan.scenarios || []));
    } catch { /* ignore parse errors */ }
  }

  // Filter by testIds
  if (testIds.length > 0) {
    allScenarios = allScenarios.filter((s) => testIds.includes(s.id));
  }

  const warnings: string[] = [];
  const originalCount = allScenarios.length;
  // Cap at 10
  if (allScenarios.length > 10) {
    warnings.push(
      `Scenario count (${allScenarios.length}) exceeds the MVP-0 cap of 10. Truncating to the first 10 scenarios.`,
    );
    allScenarios = allScenarios.slice(0, 10);
  }

  _timeline.push({
    step: 'plan-load',
    start: planLoadStart,
    durationMs: Date.now() - planLoadStart,
  });

  // Check Docker — only when an injected DockerManager is present (test path).
  // In production (sandbox=undefined) createSandbox performs its own docker check.
  if (!sandbox && ctx.docker) {
    try {
      await ctx.docker.ping();
    } catch {
      throw new McpError(
        ErrorCode.InternalError,
        'ERR_DOCKER_UNAVAILABLE',
        {
          code: 'ERR_DOCKER_UNAVAILABLE',
          suggestion: 'Start Docker Desktop or install Docker and ensure the daemon is running.',
        },
      );
    }
  }

  // ── Step: cc-generate ─────────────────────────────────────────────────────
  const ccGenStart = Date.now();
  const generatedTestsDir = path.join(tsprDir, 'generated_tests');
  fs.mkdirSync(generatedTestsDir, { recursive: true });

  const scenarioJson = JSON.stringify(allScenarios, null, 2);
  const codeGenPrompt = `You are a senior QA engineer. Generate vitest + supertest TypeScript test code for the following test scenarios.
${additionalInstruction ? `Additional instructions: ${additionalInstruction}\n` : ''}
Project: ${projectName}

Scenarios:
${scenarioJson}

Generate a single TypeScript test file using vitest. Import from 'vitest' and use supertest for HTTP tests.
Return ONLY the TypeScript code, no markdown fences.`;

  let generatedCode = '';
  let ccDurationMs = 0;
  let ccResponseChars = 0;
  const modelUsed = ctx.config.model ?? 'unknown';

  try {
    const ccStart = Date.now();
    const ccResult = await ctx.llmClient.run({
      model: 'sonnet',
      prompt: codeGenPrompt,
      timeoutMs: 120_000,
    });
    ccDurationMs = Date.now() - ccStart;
    generatedCode = ccResult.stdout.trim().replace(/^```(?:typescript|ts)?\s*/i, '').replace(/```\s*$/, '');
    ccResponseChars = generatedCode.length;
  } catch {
    throw new McpError(
      ErrorCode.InternalError,
      'ERR_CC_FAILED',
      { code: 'ERR_CC_FAILED', suggestion: 'Check that the claude CLI is installed and authenticated.' },
    );
  }

  _timeline.push({
    step: 'cc-generate',
    start: ccGenStart,
    durationMs: ccDurationMs,
    modelUsed,
    costUsd: 0,   // cost not tracked at this layer yet
    promptChars: codeGenPrompt.length,
    responseChars: ccResponseChars,
  });

  const specFilePath = path.join(generatedTestsDir, `${projectName}.spec.ts`);
  try {
    fs.writeFileSync(specFilePath, generatedCode, 'utf-8');
  } catch (err) {
    throw new McpError(
      ErrorCode.InternalError,
      'ERR_WRITE_FAILED',
      { code: 'ERR_WRITE_FAILED', suggestion: 'Check filesystem permissions.', cause: String(err) },
    );
  }

  // ── Step: sandbox-exec ────────────────────────────────────────────────────
  const sandboxStart = Date.now();

  // Execute in Docker sandbox (or mock)
  let sandboxResult: { stdout: string; stderr: string; exitCode: number };

  if (sandbox) {
    // Use provided mock/real sandbox
    try {
      sandboxResult = await sandbox.run({
        image: ctx.config.dockerImage,
        binds: [
          `${projectPath}:/workspace`,
          `${generatedTestsDir}:/tests`,
        ],
        cmd: ['sh', '-c', 'cd /workspace && npm install --silent && npx vitest run /tests/*.spec.ts --reporter=json 2>&1 || true'],
        labels: { tspr: 'true' },
        timeoutMs: ctx.config.executeTimeoutMs,
      });
    } catch {
      throw new McpError(
        ErrorCode.InternalError,
        'ERR_DOCKER_UNAVAILABLE',
        { code: 'ERR_DOCKER_UNAVAILABLE', suggestion: 'Start Docker Desktop.' },
      );
    }
  } else {
    // Production path: use real sandbox module (createSandbox / exec / pullArtifacts / dispose).
    // Generated tests are available inside the container at /work/.tspr/generated_tests.
    // We copy them into /tspr-runtime/tests (the pre-baked isolated runtime) to avoid
    // pnpm symlink chaos from the user project's node_modules.
    let handle;
    try {
      handle = await createSandbox({
        projectPath,
        projectType: 'backend',
        env: { CI: '1' },
      });
    } catch (err) {
      ctx.logger.error('sandbox create failed', { err: String(err) });
      if (err instanceof SandboxError) {
        throw new McpError(
          ErrorCode.InternalError,
          err.code,
          { code: err.code, suggestion: 'Start Docker Desktop or install Docker and ensure the daemon is running.', cause: String(err) },
        );
      }
      throw err;
    }

    try {
      // Copy generated tests into the isolated runtime dir (no npm install needed — pre-baked)
      const copyResult = await handle.exec(
        'rm -rf /tspr-runtime/tests/* && cp -r /work/.tspr/generated_tests/. /tspr-runtime/tests/',
        { cwd: '/', timeout: 30_000 },
      );
      if (copyResult.exitCode !== 0) {
        ctx.logger.warn('test copy exited non-zero', {
          exitCode: copyResult.exitCode,
          stderr: copyResult.stderr,
          stdout: copyResult.stdout,
        });
      }

      // Run vitest from the isolated runtime — absolute path avoids npx/pnpm resolution
      const testBaseUrl = process.env.TSPR_TEST_BASE_URL ?? 'http://host.docker.internal:3003';
      const testResult = await handle.exec(
        'node ./node_modules/vitest/vitest.mjs run tests/ --reporter=json 2>&1 || true',
        {
          cwd: '/tspr-runtime',
          timeout: ctx.config.executeTimeoutMs,
          env: { TEST_BASE_URL: testBaseUrl },
        },
      );

      if (testResult.exitCode !== 0 && testResult.stderr) {
        ctx.logger.warn('vitest exited non-zero', {
          exitCode: testResult.exitCode,
          stderr: testResult.stderr,
        });
      }

      sandboxResult = { stdout: testResult.stdout, stderr: testResult.stderr, exitCode: testResult.exitCode };

      await handle.pullArtifacts();
    } catch (err) {
      ctx.logger.error('sandbox exec failed', { err: String(err) });
      if (err instanceof SandboxError) {
        throw new McpError(
          ErrorCode.InternalError,
          err.code,
          { code: err.code, suggestion: 'Docker sandbox execution failed.', cause: String(err) },
        );
      }
      throw err;
    } finally {
      await handle.dispose();
    }
  }

  _timeline.push({
    step: 'sandbox-exec',
    start: sandboxStart,
    durationMs: Date.now() - sandboxStart,
  });

  // ── Step: parse-results ───────────────────────────────────────────────────
  const parseStart = Date.now();

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const failures: ExecuteResult['failures'] = [];

  try {
    const jsonOutput = sandboxResult.stdout.trim();
    // Try to find JSON in output (vitest json reporter)
    const jsonMatch = jsonOutput.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (jsonMatch) {
      // vitest --reporter=json may emit either testResults (old) or assertionResults (new) per file entry.
      const parsed = JSON.parse(jsonMatch[1]) as {
        numPassedTests?: number;
        numFailedTests?: number;
        numPendingTests?: number;
        testResults?: Array<{
          testFilePath?: string;
          name?: string;
          /** vitest >= 1 uses assertionResults; older jest-compat reporters use testResults */
          assertionResults?: Array<{ status: string; fullName: string; failureMessages?: string[] }>;
          testResults?: Array<{ status: string; fullName: string; failureMessages?: string[] }>;
        }>;
      };

      passed = parsed.numPassedTests ?? 0;
      failed = parsed.numFailedTests ?? 0;
      skipped = parsed.numPendingTests ?? 0;

      if (parsed.testResults) {
        for (const file of parsed.testResults) {
          // Support both assertionResults (vitest >= 1) and testResults (older jest-compat format)
          const tests = file.assertionResults ?? file.testResults ?? [];
          const filePath = file.testFilePath ?? file.name ?? '';
          for (const t of tests) {
            if (t.status === 'failed') {
              const failureMessages = t.failureMessages ?? [];
              const failureMsg = failureMessages.join('\n');
              const issueId = computeStableIssueId(t.fullName, projectPath);

              // Build replay events from vitest output and test title heuristics
              const events = buildReplayEvents(
                t.fullName,
                failureMessages,
                sandboxResult.stderr,
              );

              failures.push({
                testId: t.fullName,
                issueId,
                title: t.fullName,
                stack: failureMsg,
                suggestedFixRegion: {
                  file: path.relative(projectPath, filePath),
                  lineStart: 1,
                  lineEnd: 10,
                  why: 'Test failed — check the stack trace for the root cause.',
                },
                screenshotBase64: null,  // populated below if sandbox available
                events,
              });
            }
          }
        }
      }
    }
  } catch {
    // Could not parse; use scenario count as totalTests with 0 pass
    passed = 0;
    failed = allScenarios.length;
    skipped = 0;
  }

  _timeline.push({
    step: 'parse-results',
    start: parseStart,
    durationMs: Date.now() - parseStart,
  });

  // ── Best-effort Playwright screenshots for failures ───────────────────────
  // Only available when using the real sandbox (not mock DockerSandbox).
  // captureFailureScreenshot is graceful — always returns null on any error.
  // We skip this when sandbox (mock) is provided (test path) to avoid slowdown.
  if (!sandbox && failures.length > 0) {
    // We don't have a SandboxHandle at this point (handle was disposed above).
    // Screenshots are therefore deferred to a future round that keeps the handle alive.
    // For now: attempt to infer URL from specFilePath and mark as deferred.
    // This populates inferredUrl in events for future Playwright wire-up.
    for (const failure of failures) {
      const inferredUrl = inferTestUrl(specFilePath);
      if (inferredUrl && failure.events) {
        // Add a navigation event so the UI has context even without a screenshot
        const alreadyHasNav = failure.events.some((e) => e.kind === 'navigation');
        if (!alreadyHasNav) {
          failure.events.unshift({
            ts: 0,
            kind: 'navigation',
            detail: `Navigate to ${inferredUrl}`,
            data: { url: inferredUrl },
          });
        }
      }
    }
  }

  const totalTests = passed + failed + skipped;
  const status = computeStatus(passed, failed, skipped);
  const totalDurationMs = _timeline.reduce((s, t) => s + t.durationMs, 0);

  // Write artifacts
  const outputPath = path.join(tsprDir, 'test_results.json');
  const reportPath = path.join(tsprDir, 'report.html');

  // Build the human-readable summary for cc to relay verbatim
  const htmlRunId = crypto.randomUUID();
  const summary = buildSummary(
    projectName,
    totalTests,
    passed,
    failed,
    skipped,
    failures,
    warnings,
    modelUsed,
    totalDurationMs,
    htmlRunId,
    reportPath,
    allScenarios,
  );

  // ── Step: write-artifacts ─────────────────────────────────────────────────
  const writeStart = Date.now();

  const resultData: ExecuteResult = {
    status,
    outputPath,
    reportPath,
    totalTests,
    passed,
    failed,
    skipped,
    warnings,
    failures,
    summary,
    _timeline,
  };

  try {
    fs.writeFileSync(outputPath, JSON.stringify(resultData, null, 2), 'utf-8');
  } catch (err) {
    throw new McpError(
      ErrorCode.InternalError,
      'ERR_WRITE_FAILED',
      { code: 'ERR_WRITE_FAILED', suggestion: 'Check filesystem permissions.', cause: String(err) },
    );
  }

  // Write HTML report via pretty renderer
  const reportHtml = renderHtmlReport({
    runId: htmlRunId,
    projectName,
    startedAt: new Date(),
    durationMs: totalDurationMs,
    provider: 'unknown',
    modelId: modelUsed,
    costUsd: 0,
    totalTests,
    passed,
    failed,
    skipped,
    status,
    warnings,
    failures: failures.map((f) => ({
      testId: f.testId,
      title: f.title,
      stack: f.stack,
      suggestedFixRegion: f.suggestedFixRegion,
      suggestedPatch: f.suggestedPatch,
      domSnapshot: f.domSnapshot,
    })),
  });

  try {
    fs.writeFileSync(reportPath, reportHtml, 'utf-8');
  } catch (err) {
    throw new McpError(
      ErrorCode.InternalError,
      'ERR_WRITE_FAILED',
      { code: 'ERR_WRITE_FAILED', suggestion: 'Check filesystem permissions.', cause: String(err) },
    );
  }

  _timeline.push({
    step: 'write-artifacts',
    start: writeStart,
    durationMs: Date.now() - writeStart,
  });

  // Insert test_results rows into SQLite
  for (const scenario of allScenarios) {
    try {
      const isFailure = failures.find((f) => f.testId === scenario.id);
      const testOutcome = isFailure ? 'failed' : 'passed';
      ctx.db.prepare(
        `INSERT OR IGNORE INTO test_results (run_id, test_id, title, outcome, stack) VALUES (?, ?, ?, ?, ?)`,
      ).run(0, scenario.id, scenario.title ?? scenario.id, testOutcome, isFailure?.stack ?? null);
    } catch { /* ignore */ }
  }

  // Update _timeline in the resultData (was built before write-artifacts step)
  resultData._timeline = _timeline;

  return resultData;
}

async function generateAndExecuteHandler(args: unknown, ctx: ServerContext): Promise<ToolResult> {
  const input = args as GenerateAndExecuteInput;

  const startedAt = new Date().toISOString();
  const paramsHash = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');

  let runId: number | bigint = 0;
  try {
    const insert = ctx.db.prepare(
      `INSERT INTO runs (tool, params_hash, started_at) VALUES (?, ?, ?)`,
    );
    const result = insert.run('tspr_generate_code_and_execute', paramsHash, startedAt);
    runId = result.lastInsertRowid;
  } catch (err) {
    ctx.logger.warn('Failed to insert run row', { err });
  }

  let outcome = 'ok';
  let errorCode: string | null = null;

  try {
    const result = await runExecute(input, ctx);

    const endedAt = new Date().toISOString();
    const durationMs = new Date(endedAt).getTime() - new Date(startedAt).getTime();
    try {
      ctx.db.prepare(`UPDATE runs SET outcome = ?, ended_at = ?, duration_ms = ? WHERE id = ?`)
        .run(outcome, endedAt, durationMs, runId);
    } catch { /* ignore */ }

    // Return summary as the primary text content so cc can relay it verbatim.
    // Also include the full JSON as a second content block for programmatic use.
    return {
      content: [
        { type: 'text', text: result.summary },
        { type: 'text', text: JSON.stringify(result) },
      ],
    };
  } catch (err) {
    outcome = 'error';
    if (err instanceof McpError) {
      const data = err.data as { code?: string } | undefined;
      errorCode = data?.code ?? null;
    }
    const endedAt = new Date().toISOString();
    const durationMs = new Date(endedAt).getTime() - new Date(startedAt).getTime();
    try {
      ctx.db.prepare(`UPDATE runs SET outcome = ?, ended_at = ?, duration_ms = ?, error_code = ? WHERE id = ?`)
        .run(outcome, endedAt, durationMs, errorCode, runId);
    } catch { /* ignore */ }
    throw err;
  }
}

export const generateAndExecuteTool: ToolDefinition = {
  name: 'tspr_generate_code_and_execute',
  description:
    'Reads test plan, generates test code via cc, runs tests in a Docker container, and returns structured results with failure details and suggested fixes.',
  inputSchema: generateAndExecuteInputSchema,
  handler: generateAndExecuteHandler,
};
