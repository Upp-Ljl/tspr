/**
 * src/pr/format-comment.ts
 *
 * Markdown formatter for tspr PR comment bot.
 * Pure function — no I/O, no subprocess calls.
 *
 * Produces a TestSprite-style PR comment:
 * - Compact status header (not 8-column table)
 * - Full scenario list with ✅/❌ per row + severity badge
 * - Failures section with file:line, Fix hint, full patch diff embedded
 * - Single dashboard/report link at footer
 */

import { computeSeverity } from '../lib/severity.js';
import { relativizeFilePath } from '../tools/generateAndExecute.js';

export interface FormatCommentInput {
  runId: string;
  projectName: string;
  startedAt: Date | string;
  durationMs: number;
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
  status: 'ok' | 'partial' | 'all-failed';
  failures: Array<{
    testId: string;
    /** Stable 16-char hex issue ID */
    issueId?: string;
    title: string;
    stack?: string;
    suggestedFixRegion?: { file: string; lineStart: number; lineEnd: number; why: string };
    suggestedPatch?: string;
  }>;
  /** Full scenario list from test plan (for Scenarios section). Optional. */
  scenarios?: Array<{
    id: string;
    title?: string | null;
    endpoint?: string | null;
    description?: string | null;
    type?: string | null;
  }>;
  dashboardUrl?: string;   // e.g. http://localhost:7654/runs/<runId>
  reportUrl?: string;      // e.g. file:///.../report.html
  provider?: string;
  modelId?: string;
}

const STATUS_LABEL: Record<FormatCommentInput['status'], string> = {
  ok: '✅ all passed',
  partial: '⚠️ partial',
  'all-failed': '❌ all failed',
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
}

function formatDate(d: Date | string): string {
  const dt = typeof d === 'string' ? new Date(d) : d;
  if (isNaN(dt.getTime())) return String(d);
  return dt.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

const MAX_INLINE_FAILURES = 5;

export function formatPrComment(input: FormatCommentInput): string {
  const {
    runId,
    projectName,
    startedAt,
    durationMs,
    totalTests,
    passed,
    failed,
    skipped,
    status,
    failures,
    scenarios,
    dashboardUrl,
    reportUrl,
    provider,
    modelId,
  } = input;

  const statusLabel = STATUS_LABEL[status] ?? status;
  const modelLabel = [provider, modelId].filter(Boolean).join('/') || '—';
  const durationLabel = formatDuration(durationMs);
  const shortRunId = runId.length > 8 ? runId.slice(0, 8) : runId;
  const skipPart = skipped > 0 ? ` · ${skipped} skipped` : '';

  const lines: string[] = [];

  // ── Header ──────────────────────────────────────────────────────────────────
  lines.push(`## tspr · ${statusLabel}`);
  lines.push('');
  lines.push(
    `**${projectName}** · ${passed} pass · ${failed} fail${skipPart} · ${durationLabel} · ${modelLabel} · runId \`${shortRunId}\``,
  );
  lines.push('');
  lines.push(`_Run started: ${formatDate(startedAt)}_`);
  lines.push('');

  // ── Scenarios list ───────────────────────────────────────────────────────────
  const failureByTestId = new Map(failures.map((f) => [f.testId, f]));

  if (scenarios && scenarios.length > 0) {
    lines.push('### Scenarios');
    lines.push('');

    for (const scenario of scenarios) {
      const failure = failureByTestId.get(scenario.id);
      const isPassed = !failure;
      const icon = isPassed ? '✅' : '❌';
      const badge = computeSeverity({ type: scenario.type });
      const displayTitle =
        scenario.title ||
        scenario.endpoint ||
        scenario.description ||
        scenario.id;

      lines.push(`- ${icon} \`${badge}\` ${displayTitle}`);
    }

    lines.push('');
  }

  // ── Failures section ─────────────────────────────────────────────────────────
  if (failed === 0) {
    lines.push('### ✅ No failures');
    lines.push('');
  } else {
    const inlineCount = Math.min(failures.length, MAX_INLINE_FAILURES);
    const overflow = failures.length - inlineCount;

    lines.push(`### ❌ Failures (${failed})`);
    lines.push('');

    for (let i = 0; i < inlineCount; i++) {
      const f = failures[i];

      // Severity badge from matched scenario or default Major
      const matchedScenario = scenarios?.find((s) => s.id === f.testId);
      const badge = computeSeverity({ type: matchedScenario?.type });
      const shortIssueId = f.issueId ? f.issueId.slice(0, 4) : String(i + 1).padStart(4, '0');

      // Title — truncated for readability
      const displayTitle = f.title.length > 80 ? f.title.slice(0, 77) + '…' : f.title;

      lines.push(`#### ❌ issue-${shortIssueId} · \`${badge}\` ${displayTitle}`);
      lines.push('');

      // File:line
      const loc = f.suggestedFixRegion
        ? `${relativizeFilePath(f.suggestedFixRegion.file)}:${f.suggestedFixRegion.lineStart}`
        : extractFileFromStack(f.stack);
      if (loc) {
        lines.push(`- **File:** \`${loc}\``);
      }

      // Fix hint (why, truncated)
      if (f.suggestedFixRegion?.why) {
        const why = f.suggestedFixRegion.why.length > 120
          ? f.suggestedFixRegion.why.slice(0, 117) + '…'
          : f.suggestedFixRegion.why;
        lines.push(`- **Fix:** ${why}`);
      }

      // Apply hint
      if (f.issueId) {
        lines.push(`- **Apply:** \`tspr apply-fix ${f.issueId.slice(0, 4)}\` (or say "apply tspr fix ${f.issueId.slice(0, 4)}")`);
      }

      // Stack trace — collapsed
      if (f.stack) {
        const stackLines = f.stack.split('\n').slice(0, 4).join('\n');
        lines.push('');
        lines.push('<details>');
        lines.push('<summary>Stack trace</summary>');
        lines.push('');
        lines.push('```');
        lines.push(stackLines);
        lines.push('```');
        lines.push('</details>');
      }

      // Suggested patch diff — embedded inline (PR comment is more verbose than chat)
      if (f.suggestedPatch) {
        lines.push('');
        lines.push('<details>');
        lines.push('<summary>Suggested patch</summary>');
        lines.push('');
        lines.push('```diff');
        lines.push(f.suggestedPatch);
        lines.push('```');
        lines.push('</details>');
      }

      lines.push('');
    }

    if (overflow > 0) {
      const reportLink =
        dashboardUrl
          ? `[full report ↗](${dashboardUrl})`
          : reportUrl
            ? `[full report ↗](${reportUrl})`
            : 'the dashboard';
      lines.push(`_… and ${overflow} more — see ${reportLink}_`);
      lines.push('');
    }
  }

  // ── Footer ───────────────────────────────────────────────────────────────────
  const linkUrl = dashboardUrl ?? reportUrl;
  if (linkUrl) {
    lines.push('---');
    lines.push(`[Full report ↗](${linkUrl})`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Extract file:line from a stack trace string.
 * Returns the first non-node_modules line in `at file:line:col` format.
 */
function extractFileFromStack(stack?: string): string | undefined {
  if (!stack) return undefined;
  for (const line of stack.split('\n')) {
    const m = line.match(/at\s+.*\((.+):(\d+):\d+\)/);
    if (m && !m[1].includes('node_modules') && !m[1].includes('tspr-runtime')) {
      return `${m[1]}:${m[2]}`;
    }
    const m2 = line.match(/at\s+((?!\[).+):(\d+):\d+$/);
    if (m2 && !m2[1].includes('node_modules') && !m2[1].includes('tspr-runtime')) {
      return `${m2[1]}:${m2[2]}`;
    }
  }
  return undefined;
}
