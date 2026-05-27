/**
 * Tool 6: tspr_generate_code_and_execute
 *
 * Reads test plan, generates test code via cc, runs in Docker, returns structured results.
 */
import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition, ToolResult, ServerContext } from '../types/mcp.js';
import { createSandbox, SandboxError } from '../sandbox/index.js';

export const generateAndExecuteInputSchema = z.object({
  projectName: z.string(),
  projectPath: z.string(),
  testIds: z.array(z.string()).default([]),
  additionalInstruction: z.string().default(''),
});

type GenerateAndExecuteInput = z.infer<typeof generateAndExecuteInputSchema>;

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
  }>;
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

export async function runExecute(
  input: GenerateAndExecuteInput,
  ctx: ServerContext,
  sandbox?: DockerSandbox,
): Promise<ExecuteResult> {
  const { projectPath, projectName, testIds, additionalInstruction } = input;
  const tsprDir = path.join(projectPath, '.tspr');

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
  // Cap at 10
  if (allScenarios.length > 10) {
    warnings.push(
      `Scenario count (${allScenarios.length}) exceeds the MVP-0 cap of 10. Truncating to the first 10 scenarios.`,
    );
    allScenarios = allScenarios.slice(0, 10);
  }

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

  // Generate test code via cc
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
  try {
    const ccResult = await ctx.ccClient.run({
      model: 'sonnet',
      prompt: codeGenPrompt,
      timeoutMs: 120_000,
    });
    generatedCode = ccResult.stdout.trim().replace(/^```(?:typescript|ts)?\s*/i, '').replace(/```\s*$/, '');
  } catch {
    throw new McpError(
      ErrorCode.InternalError,
      'ERR_CC_FAILED',
      { code: 'ERR_CC_FAILED', suggestion: 'Check that the claude CLI is installed and authenticated.' },
    );
  }

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
    // The generated tests dir is under projectPath/.tspr/generated_tests, so it is already
    // available inside the container at /work/.tspr/generated_tests.
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
      const installResult = await handle.exec(
        'npm install --silent --no-audit --no-fund',
        { cwd: '/work', timeout: 180_000 },
      );
      if (installResult.exitCode !== 0) {
        ctx.logger.warn('npm install exited non-zero', { exitCode: installResult.exitCode, stderr: installResult.stderr });
      }

      const testResult = await handle.exec(
        'npx vitest run .tspr/generated_tests/ --reporter=json 2>&1 || true',
        { cwd: '/work', timeout: ctx.config.executeTimeoutMs },
      );
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

  // Parse test results from sandbox stdout
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
              const failureMsg = (t.failureMessages || []).join('\n');
              failures.push({
                testId: t.fullName,
                title: t.fullName,
                stack: failureMsg,
                suggestedFixRegion: {
                  file: path.relative(projectPath, filePath),
                  lineStart: 1,
                  lineEnd: 10,
                  why: 'Test failed — check the stack trace for the root cause.',
                },
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

  const totalTests = passed + failed + skipped;
  const status = computeStatus(passed, failed, skipped);

  // Write artifacts
  const outputPath = path.join(tsprDir, 'test_results.json');
  const reportPath = path.join(tsprDir, 'report.html');

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

  // Write simple HTML report
  const reportHtml = `<!DOCTYPE html>
<html>
<head><title>tspr Test Report — ${projectName}</title></head>
<body>
<h1>Test Report: ${projectName}</h1>
<p>Status: <strong>${status}</strong></p>
<p>Total: ${totalTests} | Passed: ${passed} | Failed: ${failed} | Skipped: ${skipped}</p>
${warnings.length > 0 ? `<h2>Warnings</h2><ul>${warnings.map((w) => `<li>${w}</li>`).join('')}</ul>` : ''}
${failures.length > 0 ? `<h2>Failures</h2><ul>${failures.map((f) => `<li><strong>${f.title}</strong><pre>${f.stack}</pre></li>`).join('')}</ul>` : ''}
<pre>${JSON.stringify(resultData, null, 2)}</pre>
</body>
</html>`;

  try {
    fs.writeFileSync(reportPath, reportHtml, 'utf-8');
  } catch (err) {
    throw new McpError(
      ErrorCode.InternalError,
      'ERR_WRITE_FAILED',
      { code: 'ERR_WRITE_FAILED', suggestion: 'Check filesystem permissions.', cause: String(err) },
    );
  }

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

    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
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
