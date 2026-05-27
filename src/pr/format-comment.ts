/**
 * src/pr/format-comment.ts
 *
 * Markdown formatter for tspr PR comment bot.
 * Pure function — no I/O, no subprocess calls.
 */

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
    title: string;
    stack?: string;
    suggestedFixRegion?: { file: string; lineStart: number; lineEnd: number; why: string };
    suggestedPatch?: string;
  }>;
  dashboardUrl?: string;   // e.g. http://localhost:7654/runs/<runId>
  reportUrl?: string;      // e.g. file:///.../report.html
  provider?: string;
  modelId?: string;
}

const STATUS_PILL: Record<FormatCommentInput['status'], string> = {
  ok: '✅ ok',
  partial: '⚠️ partial',
  'all-failed': '❌ all-failed',
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

function extractFileLocation(
  fixRegion?: { file: string; lineStart: number; lineEnd: number; why: string },
  stack?: string,
): string | undefined {
  if (fixRegion) {
    return `${fixRegion.file}:${fixRegion.lineStart}`;
  }
  // Try to extract file:line from stack trace — first non-node_modules line
  if (stack) {
    const lines = stack.split('\n');
    for (const line of lines) {
      const m = line.match(/at\s+.*\((.+):(\d+):\d+\)/);
      if (m && !m[1].includes('node_modules')) {
        return `${m[1]}:${m[2]}`;
      }
      // Also try bare "at file:line:col" form
      const m2 = line.match(/at\s+((?!\[).+):(\d+):\d+$/);
      if (m2 && !m2[1].includes('node_modules')) {
        return `${m2[1]}:${m2[2]}`;
      }
    }
  }
  return undefined;
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
    dashboardUrl,
    reportUrl,
    provider,
    modelId,
  } = input;

  const pill = STATUS_PILL[status] ?? status;
  const modelLabel = [provider, modelId].filter(Boolean).join('/') || '—';
  const durationLabel = formatDuration(durationMs);
  const shortRunId = runId.length > 12 ? runId.slice(0, 12) + '…' : runId;

  const lines: string[] = [];

  // Header
  lines.push(`## 🤖 tspr report · status: ${pill}`);
  lines.push('');
  lines.push(`_Run started: ${formatDate(startedAt)}_`);
  lines.push('');

  // Summary table (8 columns)
  lines.push('| Project | Run | Total | Pass | Fail | Skip | Duration | Model |');
  lines.push('|---|---|---|---|---|---|---|---|');
  lines.push(
    `| ${projectName} | \`${shortRunId}\` | ${totalTests} | ${passed} | ${failed} | ${skipped} | ${durationLabel} | ${modelLabel} |`,
  );
  lines.push('');

  // Failures section — always emitted, even when failed=0
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
      const idx = i + 1;

      // Shorten title for heading
      const title = f.title.length > 80 ? f.title.slice(0, 77) + '…' : f.title;
      lines.push(`#### ${idx}. \`${title}\``);

      const loc = extractFileLocation(f.suggestedFixRegion, f.stack);
      if (loc) {
        lines.push(`- **file:** \`${loc}\``);
      }

      if (f.suggestedFixRegion?.why) {
        lines.push(`- **why:** ${f.suggestedFixRegion.why}`);
      }

      if (f.stack) {
        // Show first 3 lines of stack
        const stackLines = f.stack.split('\n').slice(0, 3).join('\n');
        lines.push('<details>');
        lines.push('<summary>Stack trace</summary>');
        lines.push('');
        lines.push('```');
        lines.push(stackLines);
        lines.push('```');
        lines.push('</details>');
      }

      if (f.suggestedPatch) {
        lines.push('- **suggested patch:**');
        lines.push('  ```diff');
        // Indent each line of the patch
        for (const patchLine of f.suggestedPatch.split('\n')) {
          lines.push('  ' + patchLine);
        }
        lines.push('  ```');
      }

      lines.push('');
    }

    if (overflow > 0) {
      const reportLink =
        dashboardUrl
          ? `[full report ↗](${dashboardUrl})`
          : reportUrl
            ? `[full report ↗](${reportUrl})`
            : 'the full report';
      lines.push(`_… and ${overflow} more — see ${reportLink}_`);
      lines.push('');
    }
  }

  // Report link footer
  const linkUrl = dashboardUrl ?? reportUrl;
  if (linkUrl) {
    lines.push(`---`);
    lines.push(`[Full report ↗](${linkUrl})`);
    lines.push('');
  }

  return lines.join('\n');
}
