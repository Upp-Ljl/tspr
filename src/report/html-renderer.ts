/**
 * src/report/html-renderer.ts
 *
 * Renders a self-contained, single-file HTML report for one tspr run.
 * No external runtime deps — all CSS and JS are inlined.
 */

export interface RenderHtmlInput {
  runId: string;
  projectName: string;
  startedAt: Date | string;
  durationMs: number;
  provider: string;       // e.g. 'minimax'
  modelId: string;        // e.g. 'MiniMax-M2.7-highspeed'
  costUsd: number;
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
  status: 'ok' | 'partial' | 'all-failed';
  warnings: string[];
  failures: Array<{
    testId: string;
    title: string;
    stack?: string;
    durationMs?: number;
    suggestedFixRegion?: { file: string; lineStart: number; lineEnd: number; why: string };
    suggestedPatch?: string;
    screenshotBase64?: string;
    domSnapshot?: string;
  }>;
  passes?: Array<{ testId: string; title: string; durationMs?: number }>;
  generatedTestsSource?: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

function fmtDate(d: Date | string): string {
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return String(d);
  return dt.toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZoneName: 'short',
  });
}

function fmtCost(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.001) return `$${usd.toFixed(6)}`;
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

function passRate(passed: number, total: number): string {
  if (total === 0) return '0%';
  return `${Math.round((passed / total) * 100)}%`;
}

// Basic diff syntax highlight (unified diff)
function highlightDiff(patch: string): string {
  return esc(patch)
    .split('\n')
    .map((line) => {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        return `<span class="diff-add">${line}</span>`;
      }
      if (line.startsWith('-') && !line.startsWith('---')) {
        return `<span class="diff-del">${line}</span>`;
      }
      if (line.startsWith('@@')) {
        return `<span class="diff-hunk">${line}</span>`;
      }
      if (line.startsWith('---') || line.startsWith('+++')) {
        return `<span class="diff-meta">${line}</span>`;
      }
      return line;
    })
    .join('\n');
}

// ──────────────────────────────────────────────────────────────────────────────
// Sub-renderers
// ──────────────────────────────────────────────────────────────────────────────

function renderFailureCard(f: RenderHtmlInput['failures'][number], idx: number): string {
  const cardId = `failure-${idx}`;
  const hasStack = f.stack && f.stack.trim().length > 0;
  const hasPatch = f.suggestedPatch && f.suggestedPatch.trim().length > 0;
  const hasRegion = f.suggestedFixRegion != null;
  const hasScreenshot = f.screenshotBase64 && f.screenshotBase64.length > 0;
  const hasDom = f.domSnapshot && f.domSnapshot.trim().length > 0;
  const dur = f.durationMs != null ? fmtDuration(f.durationMs) : null;

  return `
  <div class="failure-card" id="${cardId}">
    <div class="failure-header" onclick="toggleCard('${cardId}')">
      <span class="failure-icon">✕</span>
      <span class="failure-title">${esc(f.title)}</span>
      ${dur ? `<span class="failure-dur">${esc(dur)}</span>` : ''}
      <span class="failure-id mono">#${esc(f.testId.slice(0, 8))}</span>
      <span class="chevron" id="${cardId}-chevron">▼</span>
    </div>
    <div class="failure-body" id="${cardId}-body">
      ${hasRegion ? `
      <div class="fix-region">
        <span class="fix-region-label">Fix region</span>
        <span class="fix-region-path mono">${esc(f.suggestedFixRegion!.file)}:${f.suggestedFixRegion!.lineStart}–${f.suggestedFixRegion!.lineEnd}</span>
        <span class="fix-region-why">${esc(f.suggestedFixRegion!.why)}</span>
      </div>` : ''}
      ${hasStack ? `
      <div class="stack-section">
        <div class="section-label">Stack trace</div>
        <pre class="stack-trace"><code>${esc(f.stack!)}</code></pre>
      </div>` : ''}
      ${hasPatch ? `
      <div class="patch-section">
        <div class="section-label">Suggested patch</div>
        <pre class="patch-diff"><code>${highlightDiff(f.suggestedPatch!)}</code></pre>
      </div>` : ''}
      ${hasScreenshot ? `
      <div class="screenshot-section">
        <div class="section-label">Screenshot</div>
        <img class="screenshot-img" src="data:image/png;base64,${esc(f.screenshotBase64!)}" alt="test failure screenshot" />
      </div>` : ''}
      ${hasDom ? `
      <div class="dom-section">
        <div class="section-label dom-toggle-label" onclick="toggleDom('${cardId}-dom')">
          DOM snapshot <span class="dom-chevron" id="${cardId}-dom-chevron">▶</span>
        </div>
        <pre class="dom-snapshot hidden" id="${cardId}-dom"><code>${esc(f.domSnapshot!)}</code></pre>
      </div>` : ''}
    </div>
  </div>`;
}

function renderPassRow(p: NonNullable<RenderHtmlInput['passes']>[number], idx: number): string {
  const dur = p.durationMs != null ? fmtDuration(p.durationMs) : '—';
  return `
    <tr class="pass-row${idx % 2 === 0 ? '' : ' alt'}">
      <td class="pass-icon-cell">✓</td>
      <td class="pass-title">${esc(p.title)}</td>
      <td class="pass-id mono">${esc(p.testId.slice(0, 8))}</td>
      <td class="pass-dur">${esc(dur)}</td>
    </tr>`;
}

// ──────────────────────────────────────────────────────────────────────────────
// CSS
// ──────────────────────────────────────────────────────────────────────────────

function getCSS(): string {
  return `
/* ─── Reset + Base ─────────────────────────────────────────────────────────── */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html { font-size: 15px; -webkit-text-size-adjust: 100%; }

/* ─── Color tokens (light) ──────────────────────────────────────────────────── */
:root {
  --bg: #f8f9fb;
  --bg-card: #ffffff;
  --bg-muted: #f3f4f6;
  --bg-code: #1e2030;
  --border: #e2e5ea;
  --border-card: #e5e7eb;

  --text: #111827;
  --text-secondary: #6b7280;
  --text-tertiary: #9ca3af;
  --text-on-dark: #e2e8f0;

  --green: #16a34a;
  --green-bg: #f0fdf4;
  --green-border: #bbf7d0;
  --green-pill-bg: #dcfce7;
  --green-pill-text: #15803d;

  --yellow: #ca8a04;
  --yellow-bg: #fffbeb;
  --yellow-border: #fde68a;
  --yellow-pill-bg: #fef9c3;
  --yellow-pill-text: #854d0e;

  --red: #dc2626;
  --red-bg: #fef2f2;
  --red-border: #fecaca;
  --red-pill-bg: #fee2e2;
  --red-pill-text: #991b1b;

  --blue: #2563eb;
  --blue-bg: #eff6ff;
  --blue-border: #bfdbfe;

  --diff-add-bg: #1a3320;
  --diff-del-bg: #3a1a1a;
  --diff-hunk-color: #60a5fa;
  --diff-meta-color: #94a3b8;

  --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  --font-mono: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', 'SF Mono', monospace;

  --radius-sm: 4px;
  --radius: 8px;
  --radius-lg: 12px;

  --shadow-sm: 0 1px 3px rgba(0,0,0,.06), 0 1px 2px rgba(0,0,0,.04);
  --shadow: 0 4px 6px -1px rgba(0,0,0,.07), 0 2px 4px -1px rgba(0,0,0,.05);
}

/* ─── Dark mode ─────────────────────────────────────────────────────────────── */
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117;
    --bg-card: #161b22;
    --bg-muted: #1c2128;
    --bg-code: #0d1117;
    --border: #30363d;
    --border-card: #30363d;

    --text: #e6edf3;
    --text-secondary: #8b949e;
    --text-tertiary: #6e7681;
    --text-on-dark: #e6edf3;

    --green: #3fb950;
    --green-bg: #0d2217;
    --green-border: #196c2e;
    --green-pill-bg: #1a4731;
    --green-pill-text: #3fb950;

    --yellow: #d29922;
    --yellow-bg: #2a1f00;
    --yellow-border: #6b4e00;
    --yellow-pill-bg: #3a2800;
    --yellow-pill-text: #d29922;

    --red: #f85149;
    --red-bg: #2a0a0a;
    --red-border: #6e1010;
    --red-pill-bg: #3a1010;
    --red-pill-text: #f85149;

    --blue: #58a6ff;
    --blue-bg: #0d2045;
    --blue-border: #1d4580;

    --diff-add-bg: #0d2a16;
    --diff-del-bg: #2a0d0d;
    --diff-hunk-color: #58a6ff;
    --diff-meta-color: #8b949e;

    --shadow-sm: 0 1px 3px rgba(0,0,0,.3);
    --shadow: 0 4px 6px -1px rgba(0,0,0,.4);
  }
}

/* ─── Layout ────────────────────────────────────────────────────────────────── */
body {
  font-family: var(--font-sans);
  background: var(--bg);
  color: var(--text);
  line-height: 1.6;
  min-height: 100vh;
}

.page-wrapper {
  max-width: 960px;
  margin: 0 auto;
  padding: 24px 20px 64px;
}

/* ─── Header ────────────────────────────────────────────────────────────────── */
.report-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 28px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--border);
}

.header-left { flex: 1; min-width: 0; }

.project-name {
  font-size: 1.5rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--text);
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.header-meta {
  margin-top: 6px;
  font-size: 0.82rem;
  color: var(--text-secondary);
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  align-items: center;
}

.header-meta .mono { font-family: var(--font-mono); font-size: 0.78rem; }

.header-right { flex-shrink: 0; }

/* ─── Status pill ───────────────────────────────────────────────────────────── */
.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: 999px;
  font-size: 0.82rem;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.status-pill.ok {
  background: var(--green-pill-bg);
  color: var(--green-pill-text);
  border: 1px solid var(--green-border);
}
.status-pill.partial {
  background: var(--yellow-pill-bg);
  color: var(--yellow-pill-text);
  border: 1px solid var(--yellow-border);
}
.status-pill.all-failed {
  background: var(--red-pill-bg);
  color: var(--red-pill-text);
  border: 1px solid var(--red-border);
}

.pill-dot {
  width: 7px; height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.ok .pill-dot { background: var(--green); }
.partial .pill-dot { background: var(--yellow); }
.all-failed .pill-dot { background: var(--red); }

/* ─── Stats strip ───────────────────────────────────────────────────────────── */
.stats-strip {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 12px;
  margin-bottom: 28px;
}

.stat-card {
  background: var(--bg-card);
  border: 1px solid var(--border-card);
  border-radius: var(--radius);
  padding: 14px 16px;
  box-shadow: var(--shadow-sm);
}

.stat-label {
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-tertiary);
  margin-bottom: 4px;
}

.stat-value {
  font-size: 1.35rem;
  font-weight: 700;
  color: var(--text);
  line-height: 1.2;
}

.stat-value.green { color: var(--green); }
.stat-value.red { color: var(--red); }
.stat-value.yellow { color: var(--yellow); }
.stat-value.mono { font-family: var(--font-mono); font-size: 0.85rem; }

/* ─── Progress bar ──────────────────────────────────────────────────────────── */
.progress-bar-wrap {
  margin-bottom: 28px;
  background: var(--bg-card);
  border: 1px solid var(--border-card);
  border-radius: var(--radius);
  padding: 16px;
  box-shadow: var(--shadow-sm);
}

.progress-label {
  display: flex;
  justify-content: space-between;
  margin-bottom: 10px;
  font-size: 0.82rem;
  color: var(--text-secondary);
}

.progress-bar {
  height: 10px;
  border-radius: 999px;
  background: var(--bg-muted);
  overflow: hidden;
  display: flex;
}

.bar-pass { background: var(--green); transition: width .3s; }
.bar-fail { background: var(--red); transition: width .3s; }
.bar-skip { background: var(--text-tertiary); transition: width .3s; }

/* ─── Section headings ──────────────────────────────────────────────────────── */
.section {
  margin-bottom: 32px;
}

.section-heading {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 1rem;
  font-weight: 700;
  margin-bottom: 14px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--border);
}

.section-heading.failures { color: var(--red); border-color: var(--red-border); }
.section-heading.passes   { color: var(--green); border-color: var(--green-border); }
.section-heading.warnings { color: var(--yellow); border-color: var(--yellow-border); }
.section-heading.source   { color: var(--text-secondary); }

.section-count {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 700;
}

.failures .section-count { background: var(--red-pill-bg); color: var(--red-pill-text); }
.passes   .section-count { background: var(--green-pill-bg); color: var(--green-pill-text); }
.warnings .section-count { background: var(--yellow-pill-bg); color: var(--yellow-pill-text); }

/* ─── Failure cards ─────────────────────────────────────────────────────────── */
.failure-card {
  background: var(--bg-card);
  border: 1px solid var(--red-border);
  border-radius: var(--radius);
  margin-bottom: 10px;
  box-shadow: var(--shadow-sm);
  overflow: hidden;
}

.failure-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  cursor: pointer;
  user-select: none;
  flex-wrap: wrap;
}

.failure-header:hover { background: var(--red-bg); }

.failure-icon {
  flex-shrink: 0;
  color: var(--red);
  font-size: 0.85rem;
  font-weight: 700;
}

.failure-title {
  flex: 1;
  font-size: 0.88rem;
  font-weight: 600;
  color: var(--text);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.failure-dur, .failure-id {
  font-size: 0.78rem;
  color: var(--text-tertiary);
  flex-shrink: 0;
}

.chevron {
  flex-shrink: 0;
  font-size: 0.7rem;
  color: var(--text-tertiary);
  transition: transform .2s;
}

.chevron.open { transform: rotate(180deg); }

.failure-body {
  border-top: 1px solid var(--red-border);
  padding: 16px;
  display: none;
}
.failure-body.open { display: block; }

/* ─── Fix region ────────────────────────────────────────────────────────────── */
.fix-region {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--blue-bg);
  border: 1px solid var(--blue-border);
  border-radius: var(--radius-sm);
  margin-bottom: 12px;
  font-size: 0.82rem;
}

.fix-region-label {
  font-weight: 600;
  color: var(--blue);
  text-transform: uppercase;
  font-size: 0.72rem;
  letter-spacing: .05em;
}
.fix-region-path { color: var(--blue); }
.fix-region-why  { color: var(--text-secondary); flex: 1; }

/* ─── Stack + patch ─────────────────────────────────────────────────────────── */
.section-label {
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: .05em;
  text-transform: uppercase;
  color: var(--text-tertiary);
  margin-bottom: 6px;
}

.stack-trace, .patch-diff, .dom-snapshot, .source-code {
  background: var(--bg-code);
  border-radius: var(--radius-sm);
  padding: 12px 14px;
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: 0.78rem;
  line-height: 1.6;
  color: var(--text-on-dark);
  white-space: pre;
  margin-bottom: 12px;
}

/* diff colors */
.diff-add  { display: block; background: var(--diff-add-bg); color: #7ee787; }
.diff-del  { display: block; background: var(--diff-del-bg); color: #f97583; }
.diff-hunk { display: block; color: var(--diff-hunk-color); }
.diff-meta { display: block; color: var(--diff-meta-color); }

/* ─── Screenshot ────────────────────────────────────────────────────────────── */
.screenshot-section { margin-bottom: 12px; }
.screenshot-img {
  max-width: 100%;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-card);
  box-shadow: var(--shadow);
}

/* dom toggle */
.dom-toggle-label { cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
.dom-toggle-label:hover { color: var(--text-secondary); }
.dom-chevron { font-size: 0.7rem; }

/* ─── Pass table ────────────────────────────────────────────────────────────── */
.passes-toggle {
  cursor: pointer;
  font-size: 0.82rem;
  color: var(--text-secondary);
  padding: 6px 0 10px;
  user-select: none;
}
.passes-toggle:hover { color: var(--green); }

.pass-table-wrap { overflow-x: auto; }

.pass-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.83rem;
}

.pass-table th {
  text-align: left;
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: .05em;
  text-transform: uppercase;
  color: var(--text-tertiary);
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
}

.pass-table td {
  padding: 7px 10px;
  border-bottom: 1px solid var(--border);
  color: var(--text);
}

.pass-icon-cell { color: var(--green); font-weight: 700; width: 28px; }
.pass-id   { color: var(--text-tertiary); width: 90px; }
.pass-dur  { color: var(--text-tertiary); width: 80px; text-align: right; }
.pass-row.alt td { background: var(--bg-muted); }

/* ─── Warnings ──────────────────────────────────────────────────────────────── */
.warning-item {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 10px 14px;
  background: var(--yellow-bg);
  border: 1px solid var(--yellow-border);
  border-radius: var(--radius-sm);
  font-size: 0.85rem;
  color: var(--text);
  margin-bottom: 8px;
}
.warning-icon { flex-shrink: 0; font-size: 0.95rem; margin-top: 1px; }

/* ─── Footer ────────────────────────────────────────────────────────────────── */
.report-footer {
  margin-top: 48px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
  font-size: 0.78rem;
  color: var(--text-tertiary);
  display: flex;
  flex-wrap: wrap;
  gap: 8px 24px;
  align-items: center;
  justify-content: space-between;
}

.footer-brand { font-weight: 600; color: var(--text-secondary); }
.footer-meta  { display: flex; flex-wrap: wrap; gap: 4px 16px; }
.footer-runid { font-family: var(--font-mono); font-size: 0.72rem; letter-spacing: .04em; }

/* ─── Hidden util ───────────────────────────────────────────────────────────── */
.hidden { display: none !important; }

/* ─── Responsive ────────────────────────────────────────────────────────────── */
@media (max-width: 600px) {
  .page-wrapper { padding: 16px 12px 48px; }
  .project-name { font-size: 1.2rem; }
  .stats-strip  { grid-template-columns: repeat(2, 1fr); }
  .failure-title { font-size: 0.8rem; }
  .stat-value { font-size: 1.1rem; }
}
`.trim();
}

// ──────────────────────────────────────────────────────────────────────────────
// JS (vanilla, minimal)
// ──────────────────────────────────────────────────────────────────────────────

function getJS(): string {
  return `
function toggleCard(id) {
  var body    = document.getElementById(id + '-body');
  var chevron = document.getElementById(id + '-chevron');
  if (!body) return;
  var isOpen = body.classList.toggle('open');
  if (chevron) chevron.classList.toggle('open', isOpen);
}
function toggleDom(id) {
  var el = document.getElementById(id);
  var ch = document.getElementById(id + '-chevron');
  if (!el) return;
  var hidden = el.classList.toggle('hidden');
  if (ch) ch.textContent = hidden ? '▶' : '▼';
}
function togglePasses() {
  var tbl  = document.getElementById('passes-table-wrap');
  var btn  = document.getElementById('passes-toggle-btn');
  if (!tbl || !btn) return;
  var hidden = tbl.classList.toggle('hidden');
  btn.textContent = hidden ? '▶ Show passed tests' : '▼ Hide passed tests';
}
function toggleSource() {
  var tbl = document.getElementById('source-wrap');
  var btn = document.getElementById('source-toggle-btn');
  if (!tbl || !btn) return;
  var hidden = tbl.classList.toggle('hidden');
  btn.textContent = hidden ? '▶ Show generated test source' : '▼ Hide generated test source';
}
`.trim();
}

// ──────────────────────────────────────────────────────────────────────────────
// Main renderer
// ──────────────────────────────────────────────────────────────────────────────

export function renderHtmlReport(input: RenderHtmlInput): string {
  const {
    runId, projectName, startedAt, durationMs, provider, modelId,
    costUsd, totalTests, passed, failed, skipped, status, warnings,
    failures, passes, generatedTestsSource,
  } = input;

  // Status pill text
  const statusLabel = status === 'ok' ? 'All Tests Passed'
    : status === 'partial' ? 'Partial Failure'
    : 'All Tests Failed';

  // Progress bar widths
  const total = totalTests || 1;
  const passW = Math.round((passed / total) * 100);
  const failW = Math.round((failed / total) * 100);
  const skipW = Math.max(0, 100 - passW - failW);

  // Failures section
  const failuresSection = failures.length > 0 ? `
  <section class="section">
    <h2 class="section-heading failures">
      ✕ Failures
      <span class="section-count">${failures.length}</span>
    </h2>
    ${failures.map((f, i) => renderFailureCard(f, i)).join('\n')}
  </section>` : '';

  // Passes section
  const passesData = passes ?? [];
  const passesSection = passesData.length > 0 ? `
  <section class="section">
    <h2 class="section-heading passes">
      ✓ Passed
      <span class="section-count">${passesData.length}</span>
    </h2>
    <div class="passes-toggle" id="passes-toggle-btn" onclick="togglePasses()">▼ Hide passed tests</div>
    <div id="passes-table-wrap" class="pass-table-wrap">
      <table class="pass-table">
        <thead>
          <tr>
            <th></th>
            <th>Test</th>
            <th>ID</th>
            <th style="text-align:right">Duration</th>
          </tr>
        </thead>
        <tbody>
          ${passesData.map((p, i) => renderPassRow(p, i)).join('\n')}
        </tbody>
      </table>
    </div>
  </section>` : '';

  // Warnings section
  const warningsSection = warnings.length > 0 ? `
  <section class="section">
    <h2 class="section-heading warnings">
      ⚠ Warnings
      <span class="section-count">${warnings.length}</span>
    </h2>
    ${warnings.map((w) => `
    <div class="warning-item">
      <span class="warning-icon">⚠</span>
      <span>${esc(w)}</span>
    </div>`).join('')}
  </section>` : '';

  // Generated test source
  const sourceSection = generatedTestsSource ? `
  <section class="section">
    <h2 class="section-heading source">
      ⟨/⟩ Generated Test Source
    </h2>
    <div class="passes-toggle" id="source-toggle-btn" onclick="toggleSource()">▶ Show generated test source</div>
    <div id="source-wrap" class="hidden">
      <pre class="source-code"><code>${esc(generatedTestsSource)}</code></pre>
    </div>
  </section>` : '';

  const dateStr = fmtDate(startedAt);
  const durStr  = fmtDuration(durationMs);
  const costStr = fmtCost(costUsd);
  const rate    = passRate(passed, totalTests);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>tspr Report — ${esc(projectName)}</title>
  <style>
${getCSS()}
  </style>
</head>
<body>
<div class="page-wrapper">

  <!-- ── Header ── -->
  <header class="report-header">
    <div class="header-left">
      <h1 class="project-name">${esc(projectName)}</h1>
      <div class="header-meta">
        <span>${esc(dateStr)}</span>
        <span>Duration: <strong>${esc(durStr)}</strong></span>
        <span>Cost: <strong>${esc(costStr)}</strong></span>
        <span class="mono" title="Run ID">${esc(runId)}</span>
      </div>
    </div>
    <div class="header-right">
      <span class="status-pill ${esc(status)}">
        <span class="pill-dot"></span>
        ${esc(statusLabel)}
      </span>
    </div>
  </header>

  <!-- ── Stats strip ── -->
  <div class="stats-strip">
    <div class="stat-card">
      <div class="stat-label">Total</div>
      <div class="stat-value">${totalTests}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Passed</div>
      <div class="stat-value green">${passed}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Failed</div>
      <div class="stat-value${failed > 0 ? ' red' : ''}">${failed}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Skipped</div>
      <div class="stat-value${skipped > 0 ? ' yellow' : ''}">${skipped}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Pass Rate</div>
      <div class="stat-value${failed === 0 ? ' green' : failed > 0 && passed > 0 ? ' yellow' : ' red'}">${esc(rate)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Duration</div>
      <div class="stat-value mono">${esc(durStr)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Model</div>
      <div class="stat-value mono" style="font-size:.78rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(modelId)}">${esc(modelId)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Provider</div>
      <div class="stat-value mono" style="font-size:.9rem">${esc(provider)}</div>
    </div>
  </div>

  <!-- ── Progress bar ── -->
  <div class="progress-bar-wrap">
    <div class="progress-label">
      <span>${passed} passed · ${failed} failed · ${skipped} skipped</span>
      <span>${esc(rate)} pass rate</span>
    </div>
    <div class="progress-bar">
      <div class="bar-pass" style="width:${passW}%"></div>
      <div class="bar-fail" style="width:${failW}%"></div>
      <div class="bar-skip" style="width:${skipW}%"></div>
    </div>
  </div>

  ${failuresSection}
  ${passesSection}
  ${warningsSection}
  ${sourceSection}

  <!-- ── Footer ── -->
  <footer class="report-footer">
    <span class="footer-brand">tspr</span>
    <div class="footer-meta">
      <span>provider=<strong>${esc(provider)}</strong></span>
      <span>model=<strong>${esc(modelId)}</strong></span>
      <span class="footer-runid">runId=${esc(runId)}</span>
    </div>
  </footer>

</div>
<script>
${getJS()}
</script>
</body>
</html>`;
}
