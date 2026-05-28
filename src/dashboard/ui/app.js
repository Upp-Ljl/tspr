/* tspr dashboard — app.js (vanilla, no deps) */
'use strict';

// ── Utilities ──────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function relativeTime(iso) {
  if (!iso) return '—';
  var delta = (Date.now() - new Date(iso).getTime()) / 1000;
  if (delta < 60) return Math.round(delta) + 's ago';
  if (delta < 3600) return Math.round(delta / 60) + 'm ago';
  if (delta < 86400) return Math.round(delta / 3600) + 'h ago';
  return Math.round(delta / 86400) + 'd ago';
}

function formatMs(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  return Math.round(ms / 60000) + 'm ' + Math.round((ms % 60000) / 1000) + 's';
}

function projectLabel(p) {
  if (!p) return '—';
  var parts = p.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || p;
}

function statusDot(status) {
  if (status === 'healthy') return '🟢';
  if (status === 'issues')  return '🟡';
  return '🔴';
}

function pillHtml(status) {
  var cls = { ok:'pill--ok', healthy:'pill--ok', partial:'pill--partial', issues:'pill--partial',
    failed:'pill--failed', 'all-failed':'pill--all-failed', error:'pill--error',
    broken:'pill--failed', 'in-progress':'pill--in-progress' }[status] || 'pill--in-progress';
  var label = { ok:'✓ ok', healthy:'✓ healthy', partial:'⚠ partial', issues:'⚠ issues',
    failed:'✗ failed', 'all-failed':'✗ all-failed', error:'✗ error',
    broken:'✗ broken', 'in-progress':'⟳ running' }[status] || status;
  return '<span class="pill ' + cls + '">' + escHtml(label) + '</span>';
}

function pct(n) {
  return n != null ? Math.round(n * 100) + '%' : '—';
}

function copyToClipboard(text, btn) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function () {
      flashCopied(btn);
    }).catch(function () {
      legacyCopy(text, btn);
    });
  } else {
    legacyCopy(text, btn);
  }
}

function legacyCopy(text, btn) {
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try { document.execCommand('copy'); flashCopied(btn); } catch (e) { /* ignore */ }
  document.body.removeChild(ta);
}

function flashCopied(btn) {
  if (!btn) return;
  var orig = btn.textContent;
  btn.textContent = '✓ copied';
  btn.classList.add('btn--copied');
  setTimeout(function () {
    btn.textContent = orig;
    btn.classList.remove('btn--copied');
  }, 1800);
}

// snoozed/fixed: stored in localStorage
var SNOOZED_KEY = 'tspr_snoozed_issues';
var FIXED_KEY   = 'tspr_fixed_issues';

function getSnoozed() {
  try { return JSON.parse(localStorage.getItem(SNOOZED_KEY) || '{}'); } catch (_) { return {}; }
}
function getFixed() {
  try { return JSON.parse(localStorage.getItem(FIXED_KEY) || '{}'); } catch (_) { return {}; }
}
function snoozeIssue(testId) {
  var s = getSnoozed();
  s[testId] = Date.now() + 24 * 60 * 60 * 1000;
  localStorage.setItem(SNOOZED_KEY, JSON.stringify(s));
}
function markFixed(testId) {
  var f = getFixed();
  f[testId] = Date.now();
  localStorage.setItem(FIXED_KEY, JSON.stringify(f));
}
function isVisible(testId) {
  var snoozed = getSnoozed();
  var fixed = getFixed();
  if (fixed[testId]) return false;
  if (snoozed[testId] && snoozed[testId] > Date.now()) return false;
  return true;
}

// ── Inline SVG sparkline ───────────────────────────────────────────────────────

function renderSparkline(container, points) {
  if (!points || points.length < 2) {
    container.innerHTML = '<span style="font-size:0.75rem;color:var(--text-dim)">Not enough data</span>';
    return;
  }
  var w = Math.max(container.offsetWidth || 300, 200);
  var h = 32;
  var pad = 2;
  var n = points.length;
  var xs = points.map(function (p, i) { return pad + (i / (n - 1)) * (w - pad * 2); });
  var ys = points.map(function (p) { return h - pad - p.passRate * (h - pad * 2); });
  var polyline = xs.map(function (x, i) { return x.toFixed(1) + ',' + ys[i].toFixed(1); }).join(' ');

  var half = Math.floor(n / 2);
  var firstHalf = points.slice(0, half).reduce(function (s, p) { return s + p.passRate; }, 0) / half;
  var secondHalf = points.slice(half).reduce(function (s, p) { return s + p.passRate; }, 0) / (n - half);
  var diff = secondHalf - firstHalf;

  var arrowEl = document.getElementById('trend-arrow');
  if (arrowEl) {
    if (diff > 0.02) { arrowEl.textContent = '↑ improving (' + pct(secondHalf) + ')'; arrowEl.className = 'trend-strip__arrow up'; }
    else if (diff < -0.02) { arrowEl.textContent = '↓ regressing (' + pct(secondHalf) + ')'; arrowEl.className = 'trend-strip__arrow down'; }
    else { arrowEl.textContent = '→ stable (' + pct(secondHalf) + ')'; arrowEl.className = 'trend-strip__arrow flat'; }
  }

  container.innerHTML =
    '<svg width="' + w + '" height="' + h + '" xmlns="http://www.w3.org/2000/svg">' +
    '<polyline points="' + polyline + '" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>' +
    '</svg>';
}

// ── Inline SVG bar chart ───────────────────────────────────────────────────────

function renderDailyChart(container, trendPoints) {
  if (!trendPoints || trendPoints.length === 0) {
    container.innerHTML = '<div style="color:var(--text-dim);font-size:0.82rem;padding:0.5rem">No trend data yet.</div>';
    return;
  }
  var maxTotal = 1;
  trendPoints.forEach(function (p) { if ((p.total || 0) > maxTotal) maxTotal = p.total; });

  var html = '<div class="cost-bar-chart">';
  trendPoints.forEach(function (p) {
    var barPct = Math.round((p.total / maxTotal) * 100);
    var fillColor = p.passRate >= 0.9 ? 'var(--green)' : p.passRate >= 0.5 ? 'var(--yellow)' : 'var(--red)';
    html += '<div class="cost-bar-row">' +
      '<div class="cost-bar-row__label" title="' + escHtml(p.date) + '">' + escHtml(p.date.slice(5)) + '</div>' +
      '<div class="cost-bar-row__bar"><div class="cost-bar-row__fill" style="width:' + barPct + '%;background:' + fillColor + '"></div></div>' +
      '<div class="cost-bar-row__value">' + p.passed + '/' + p.total + '</div>' +
      '</div>';
  });
  html += '</div>';
  container.innerHTML = html;
}

// ── Patch viewer ───────────────────────────────────────────────────────────────

function renderPatch(patch) {
  if (!patch) return '<div style="color:var(--text-dim);font-size:0.78rem">No patch available.</div>';
  var lines = patch.split('\n');
  var html = '<div class="patch-viewer">';
  lines.forEach(function (line) {
    var cls = 'patch-line--ctx';
    if (line.startsWith('+') && !line.startsWith('+++')) cls = 'patch-line--add';
    else if (line.startsWith('-') && !line.startsWith('---')) cls = 'patch-line--del';
    else if (line.startsWith('@@')) cls = 'patch-line--hunk';
    html += '<span class="patch-line ' + cls + '">' + escHtml(line) + '</span>';
  });
  html += '</div>';
  return html;
}

// ── Code pane renderer ─────────────────────────────────────────────────────────

function renderCodePane(content, highlightStart, highlightEnd) {
  if (!content) return '<div class="code-pane__content" style="padding:0.75rem;color:var(--text-dim);font-size:0.78rem">File not available</div>';
  var lines = content.split('\n');
  var html = '<div class="code-pane__content">';
  lines.forEach(function (line, i) {
    var lineNum = i + 1;
    var isHl = highlightStart && highlightEnd && lineNum >= highlightStart && lineNum <= highlightEnd;
    html += '<div class="code-pane__line' + (isHl ? ' highlight' : '') + '">' +
      '<span class="code-pane__lineno">' + lineNum + '</span>' +
      '<span class="code-pane__text">' + escHtml(line) + '</span>' +
      '</div>';
  });
  html += '</div>';
  return html;
}

// ── Side panel control ─────────────────────────────────────────────────────────

function openPanel(titleHtml, bodyHtml) {
  var panel = document.getElementById('side-panel');
  var overlay = document.getElementById('panel-overlay');
  var title = document.getElementById('panel-title');
  var body = document.getElementById('panel-body');
  if (!panel || !overlay) return;
  title.innerHTML = titleHtml;
  body.innerHTML = bodyHtml;
  panel.classList.add('open');
  overlay.classList.add('show');
}

function closePanel() {
  var panel = document.getElementById('side-panel');
  var overlay = document.getElementById('panel-overlay');
  if (!panel || !overlay) return;
  panel.classList.remove('open');
  overlay.classList.remove('show');
  // Deactivate project cards
  document.querySelectorAll('.project-card.active').forEach(function (c) { c.classList.remove('active'); });
}

function wirePanel() {
  var closeBtn = document.getElementById('panel-close');
  var overlay = document.getElementById('panel-overlay');
  if (closeBtn) closeBtn.addEventListener('click', closePanel);
  if (overlay) overlay.addEventListener('click', closePanel);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closePanel();
  });
}

// ── Issue card rendering ───────────────────────────────────────────────────────

// ── Apply-fix toast ────────────────────────────────────────────────────────────

var toastTimer = null;
function showToast(msg, ok) {
  var el = document.getElementById('fix-toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'fix-toast ' + (ok ? 'fix-toast--ok' : 'fix-toast--err');
  el.style.display = 'block';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.style.display = 'none'; }, 5000);
}

function postJson(url, data) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, body: j }; }); });
}

function applyFix(issue, btn, onDone) {
  if (!issue.projectPath) { showToast('No projectPath on issue — cannot apply fix.', false); return; }
  if (!issue.issueId) { showToast('No issueId on issue — old fixture data? Re-run tspr.', false); return; }
  btn.classList.add('btn--loading');
  btn.textContent = 'Applying…';
  postJson('/api/apply-fix', {
    issueId: issue.issueId,
    projectPath: issue.projectPath,
    commit: true,
  }).then(function (r) {
    btn.classList.remove('btn--loading');
    if (r.ok && r.body.applied) {
      showToast('✓ Fix applied! Branch: ' + r.body.branch + (r.body.commitSha ? ' (' + r.body.commitSha.slice(0, 8) + ')' : ''), true);
      btn.textContent = '✓ Applied';
      btn.disabled = true;
      // Show push-pr + merge-local buttons
      if (onDone) onDone(r.body);
    } else {
      showToast('Apply fix: ' + (r.body.error || r.body.message || 'unknown error'), false);
      btn.textContent = 'Apply Fix';
    }
  }).catch(function (e) {
    btn.classList.remove('btn--loading');
    btn.textContent = 'Apply Fix';
    showToast('Network error: ' + e.message, false);
  });
}

// ── Issue card rendering ───────────────────────────────────────────────────────

function buildIssueCard(issue, idx) {
  var fixRegion = issue.suggestedFixRegion;
  var fileLabel = fixRegion ? fixRegion.file : null;
  var vsLink = null;
  if (fileLabel) {
    var normalized = fileLabel.replace(/\\/g, '/');
    vsLink = 'vscode://file/' + normalized + (fixRegion.lineStart ? ':' + fixRegion.lineStart : '');
  }

  var html = '<div class="issue-card" id="issue-' + idx + '">';
  html += '<div class="issue-card__header">';
  html += '<svg class="issue-card__chevron" width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M5 2l5 5-5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  html += '<div class="issue-card__title">' + escHtml(issue.title || issue.testId) + '</div>';
  html += '<div class="issue-card__meta">';
  if (issue.consecutiveFailures > 1) {
    html += '<span class="issue-card__streak">✗ ' + issue.consecutiveFailures + ' runs</span>';
  }
  if (issue.projectPath) {
    html += '<span class="issue-card__project">' + escHtml(projectLabel(issue.projectPath)) + '</span>';
  }
  html += '</div>';
  html += '</div>'; // header

  html += '<div class="issue-card__body">';

  if (fixRegion && fixRegion.why) {
    html += '<div class="issue-card__section-label">Why</div>';
    html += '<div class="issue-card__why">' + escHtml(fixRegion.why) + '</div>';
  }

  if (fileLabel) {
    html += '<div class="issue-card__section-label">File</div>';
    if (vsLink) {
      html += '<a class="issue-card__file-link" href="' + escHtml(vsLink) + '">' + escHtml(fileLabel);
      if (fixRegion.lineStart) html += ' L' + fixRegion.lineStart;
      if (fixRegion.lineEnd && fixRegion.lineEnd !== fixRegion.lineStart) html += '–' + fixRegion.lineEnd;
      html += '</a>';
    } else {
      html += '<span class="issue-card__file-link">' + escHtml(fileLabel) + '</span>';
    }
  }

  if (issue.suggestedPatch) {
    html += '<div class="issue-card__section-label">Suggested patch</div>';
    html += renderPatch(issue.suggestedPatch);
  }

  html += '<div class="issue-card__actions" id="issue-actions-' + idx + '">';
  if (issue.hasPatch || issue.suggestedPatch) {
    // Primary: Apply Fix (replaces old Copy patch)
    html += '<button class="btn btn--apply-fix" data-apply-fix="' + idx + '">Apply Fix</button>';
    // Secondary: View Diff (replaces nothing — new)
    html += '<button class="btn btn--view-diff" data-copy-patch="' + idx + '">View Diff</button>';
  }
  if (vsLink) {
    html += '<a class="btn" href="' + escHtml(vsLink) + '">Open in editor ↗</a>';
  } else if (fileLabel) {
    html += '<button class="btn" data-copy-path="' + idx + '">Copy path</button>';
  }
  html += '<button class="btn btn--danger" data-mark-fixed="' + escHtml(issue.testId) + '">Mark fixed</button>';
  html += '<button class="btn btn--snooze" data-snooze="' + escHtml(issue.testId) + '">Snooze 24h</button>';
  html += '</div>';

  html += '</div>'; // body
  html += '</div>'; // card
  return html;
}

// ── Transparency panel (run detail) ───────────────────────────────────────────

function renderTransparencyPanel(container, testResultsJson) {
  if (!testResultsJson) return;
  var data = null;
  try { data = JSON.parse(testResultsJson); } catch (_) { return; }
  if (!data || !data._timeline || !data._timeline.length) return;

  var timeline = data._timeline;
  var totalMs = timeline.reduce(function (s, t) { return s + (t.durationMs || 0); }, 0);

  // Timeline bar
  var barHtml = '<div class="timeline-bar">';
  var legendHtml = '<div class="timeline-legend">';
  var stepColors = {
    'plan-load': '#6366f1',
    'cc-generate': '#8b5cf6',
    'sandbox-exec': '#f59e0b',
    'parse-results': '#10b981',
    'write-artifacts': '#3b82f6',
  };
  timeline.forEach(function (step) {
    var pct = totalMs > 0 ? ((step.durationMs / totalMs) * 100).toFixed(1) : 0;
    var label = step.durationMs >= 1000
      ? (step.durationMs / 1000).toFixed(1) + 's'
      : step.durationMs + 'ms';
    barHtml += '<div class="timeline-segment" data-step="' + escHtml(step.step) + '" ' +
      'style="width:' + pct + '%" title="' + escHtml(step.step) + ': ' + label + '">' +
      (parseFloat(String(pct)) > 10 ? escHtml(step.step.replace(/-/g, ' ')) : '') +
      '</div>';
    var color = stepColors[step.step] || 'var(--accent)';
    legendHtml += '<div class="timeline-legend__item">' +
      '<div class="timeline-legend__dot" style="background:' + color + '"></div>' +
      escHtml(step.step) + ' · ' + escHtml(label) +
      '</div>';
  });
  barHtml += '</div>';
  legendHtml += '</div>';

  // LLM trace table (only steps with modelUsed)
  var llmSteps = timeline.filter(function (s) { return s.modelUsed; });
  var traceHtml = '';
  if (llmSteps.length > 0) {
    traceHtml = '<table class="llm-trace-table"><thead><tr>' +
      '<th>Step</th><th>Model</th><th>Prompt chars</th><th>Response chars</th><th>Duration</th><th>Cost USD</th>' +
      '</tr></thead><tbody>';
    llmSteps.forEach(function (s) {
      traceHtml += '<tr>' +
        '<td>' + escHtml(s.step) + '</td>' +
        '<td>' + escHtml(s.modelUsed || '—') + '</td>' +
        '<td>' + (s.promptChars != null ? s.promptChars.toLocaleString() : '—') + '</td>' +
        '<td>' + (s.responseChars != null ? s.responseChars.toLocaleString() : '—') + '</td>' +
        '<td>' + formatMs(s.durationMs) + '</td>' +
        '<td>' + (s.costUsd != null ? '$' + s.costUsd.toFixed(4) : '—') + '</td>' +
        '</tr>';
    });
    traceHtml += '</tbody></table>';
  }

  // Truncation events
  var truncHtml = '';
  if (data.warnings && data.warnings.length > 0) {
    truncHtml = '<ul style="list-style:none;display:flex;flex-direction:column;gap:0.3rem">';
    data.warnings.forEach(function (w) {
      truncHtml += '<li class="warning-item">⚠️ ' + escHtml(w) + '</li>';
    });
    truncHtml += '</ul>';
  } else {
    truncHtml = '<div style="font-size:0.78rem;color:var(--text-dim)">No truncation events.</div>';
  }

  // Raw LLM output (from cc-generate step, just show responsChars note)
  var rawSection = '<button class="raw-llm-toggle" id="raw-llm-btn">▶ Show raw LLM output (test code)</button>' +
    '<div id="raw-llm-div" class="raw-llm-output" style="display:none">';
  if (data.failures && data.failures.length > 0) {
    // Best we can do without storing raw output: show the stacks
    data.failures.forEach(function (f, i) {
      rawSection += '# Failure ' + (i + 1) + ': ' + escHtml(f.title || f.testId) + '\n';
      rawSection += (f.stack ? escHtml(f.stack.slice(0, 1500)) : '') + '\n\n';
    });
  } else {
    rawSection += 'No failures. Raw LLM code was not stored (add _rawGeneratedCode to test_results.json for full trace).';
  }
  rawSection += '</div>';

  var panelHtml = '<div class="transparency-panel" id="transparency-panel-el">' +
    '<div class="transparency-panel__toggle" id="tp-toggle">' +
    '🔍 Process Transparency' +
    '<span class="transparency-panel__caret" id="tp-caret">▼</span>' +
    '</div>' +
    '<div class="transparency-panel__body">' +
    '<div class="tp-section"><div class="tp-section__title">Process Timeline</div>' +
    barHtml + legendHtml + '</div>' +
    (traceHtml ? '<div class="tp-section"><div class="tp-section__title">LLM Trace</div>' + traceHtml + '</div>' : '') +
    '<div class="tp-section"><div class="tp-section__title">Truncation Events</div>' + truncHtml + '</div>' +
    '<div class="tp-section"><div class="tp-section__title">Raw LLM Output</div>' + rawSection + '</div>' +
    '</div>' +
    '</div>';

  container.innerHTML = panelHtml;

  var toggle = document.getElementById('tp-toggle');
  var panel = document.getElementById('transparency-panel-el');
  if (toggle && panel) {
    toggle.addEventListener('click', function () {
      panel.classList.toggle('open');
    });
  }
  var rawBtn = document.getElementById('raw-llm-btn');
  var rawDiv = document.getElementById('raw-llm-div');
  if (rawBtn && rawDiv) {
    rawBtn.addEventListener('click', function () {
      var shown = rawDiv.style.display !== 'none';
      rawDiv.style.display = shown ? 'none' : 'block';
      rawBtn.textContent = (shown ? '▶' : '▼') + ' Show raw LLM output (test code)';
    });
  }
}

// ── Wire Push PR + Merge Local post-apply buttons ─────────────────────────────

function wirePostActionBtns(actionsEl, issue) {
  actionsEl.querySelectorAll('[data-push-pr]').forEach(function (btn) {
    if (btn._wired) return;
    btn._wired = true;
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var branch = btn.getAttribute('data-branch');
      if (!branch || !issue.projectPath) { showToast('No branch/projectPath', false); return; }
      btn.textContent = 'Pushing…';
      btn.classList.add('btn--loading');
      postJson('/api/push-pr', { branch: branch, projectPath: issue.projectPath }).then(function (r) {
        btn.classList.remove('btn--loading');
        if (r.body.gh_missing) {
          showToast('gh CLI not found. Install GitHub CLI to push PRs.', false);
          btn.textContent = 'Push PR';
        } else if (r.ok && r.body.prUrl) {
          showToast('✓ PR created: ' + r.body.prUrl, true);
          btn.textContent = '✓ PR created';
          btn.disabled = true;
        } else {
          showToast('Push PR error: ' + (r.body.error || 'unknown'), false);
          btn.textContent = 'Push PR';
        }
      }).catch(function (e) {
        btn.classList.remove('btn--loading');
        btn.textContent = 'Push PR';
        showToast('Network error: ' + e.message, false);
      });
    });
  });

  actionsEl.querySelectorAll('[data-merge-local]').forEach(function (btn) {
    if (btn._wired) return;
    btn._wired = true;
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var branch = btn.getAttribute('data-branch');
      if (!branch || !issue.projectPath) { showToast('No branch/projectPath', false); return; }
      btn.textContent = 'Merging…';
      btn.classList.add('btn--loading');
      postJson('/api/merge-local', { branch: branch, projectPath: issue.projectPath }).then(function (r) {
        btn.classList.remove('btn--loading');
        if (r.ok && r.body.merged) {
          showToast('✓ Merged ' + branch + ' into ' + (r.body.base || 'main'), true);
          btn.textContent = '✓ Merged';
          btn.disabled = true;
        } else {
          showToast('Merge error: ' + (r.body.error || 'unknown'), false);
          btn.textContent = 'Merge Local';
        }
      }).catch(function (e) {
        btn.classList.remove('btn--loading');
        btn.textContent = 'Merge Local';
        showToast('Network error: ' + e.message, false);
      });
    });
  });
}

// ── Home page ──────────────────────────────────────────────────────────────────

(function initHome() {
  var projectList = document.getElementById('project-list');
  if (!projectList) return;

  wirePanel();

  var PAGE_SIZE = 25;
  var currentPage = 0;
  var allRuns = [];
  var filterProject = '';

  var projectFilter = document.getElementById('project-filter');
  if (projectFilter) {
    projectFilter.addEventListener('change', function () {
      filterProject = projectFilter.value;
      currentPage = 0;
      renderRunsList();
    });
  }

  var prevBtn = document.getElementById('runs-prev');
  var nextBtn = document.getElementById('runs-next');
  if (prevBtn) prevBtn.addEventListener('click', function () { currentPage--; renderRunsList(); });
  if (nextBtn) nextBtn.addEventListener('click', function () { currentPage++; renderRunsList(); });

  function visibleRuns() {
    if (!filterProject) return allRuns;
    return allRuns.filter(function (r) { return r.project_path === filterProject; });
  }

  function renderRunsList() {
    var runsListEl = document.getElementById('runs-list');
    if (!runsListEl) return;

    var runs = visibleRuns();
    var total = runs.length;
    var pageRuns = runs.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
    var totalPages = Math.ceil(total / PAGE_SIZE) || 1;

    var countEl = document.getElementById('runs-count');
    if (countEl) countEl.textContent = total;

    var pagerEl = document.getElementById('runs-pager');
    if (pagerEl && total > PAGE_SIZE) {
      pagerEl.textContent = 'page ' + (currentPage + 1) + ' / ' + totalPages;
    } else if (pagerEl) {
      pagerEl.textContent = '';
    }

    var pagEl = document.getElementById('runs-pagination');
    if (pagEl) pagEl.style.display = total > PAGE_SIZE ? 'flex' : 'none';
    if (prevBtn) prevBtn.disabled = currentPage <= 0;
    if (nextBtn) nextBtn.disabled = currentPage >= totalPages - 1;

    if (pageRuns.length === 0) {
      runsListEl.innerHTML = '<div class="empty-state">' +
        '<div class="empty-state__heading">No runs yet</div>' +
        '<div class="empty-state__desc">tspr hasn\'t run yet. Add it to your IDE via MCP:</div>' +
        '<pre class="empty-state__code">claude mcp add tspr -- npx tspr mcp\n\n# Then ask:\nCan you test this project with tspr?</pre>' +
        '</div>';
      return;
    }

    var html = '';
    pageRuns.forEach(function (r) {
      var runId = String(r.id || '');
      var status = (r.outcome || r.status || 'in-progress').toLowerCase();
      var proj = projectLabel(r.project_path || null);
      var runIdShort = runId.length > 10 ? runId.slice(0, 10) + '…' : runId;

      // Count pass/fail from runs table (we don't have per-run counts here; show status pill + project)
      html += '<div class="run-row" onclick="location.href=\'/runs/' + encodeURIComponent(runId) + '\'"' +
        ' role="link" tabindex="0">';
      html += '<div class="run-row__status">' + pillHtml(status) + '</div>';
      html += '<div class="run-row__body">';
      html += '<div class="run-row__title">';
      html += '<span class="run-id-cell" title="' + escHtml(runId) + '">' + escHtml(runIdShort) + '</span>';
      if (proj !== '—') html += ' · <span style="color:var(--text)">' + escHtml(proj) + '</span>';
      html += '</div>';
      html += '<div class="run-row__meta">';
      if (r.tool) html += escHtml(r.tool.replace('tspr_', '').replace(/_/g, ' '));
      if (r.duration_ms) html += ' · ' + formatMs(r.duration_ms);
      html += '</div>';
      html += '</div>';
      html += '<div class="run-row__time">' + escHtml(relativeTime(r.started_at)) + '</div>';
      html += '</div>';
    });
    runsListEl.innerHTML = html;

    // keyboard navigation
    runsListEl.querySelectorAll('.run-row').forEach(function (row) {
      row.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.click(); }
      });
    });
  }

  function renderProjectList(projects, changesMap) {
    var countEl = document.getElementById('projects-count');
    if (countEl) countEl.textContent = projects.length;

    // Populate filter dropdown
    var filterEl = document.getElementById('project-filter');
    if (filterEl && filterEl.options.length <= 1) {
      projects.forEach(function (proj) {
        var opt = document.createElement('option');
        opt.value = proj.projectPath || '';
        opt.textContent = proj.projectName;
        filterEl.appendChild(opt);
      });
    }

    if (projects.length === 0) {
      projectList.innerHTML = '<div class="empty-state empty-state--compact">' +
        '<div class="empty-state__heading">No projects yet</div>' +
        '<div class="empty-state__desc">Projects appear automatically after the first run.</div>' +
        '</div>';
      return;
    }

    var html = '';
    projects.forEach(function (proj) {
      var changes = changesMap[proj.projectPath] || null;

      html += '<div class="project-card" data-project-path="' + escHtml(proj.projectPath || '') + '">';
      html += '<div class="project-card__top">';
      html += '<span class="project-card__status-dot">' + statusDot(proj.status) + '</span>';
      html += '<span class="project-card__name">' + escHtml(proj.projectName) + '</span>';
      html += pillHtml(proj.status);
      html += '</div>';
      html += '<div class="project-card__stats">' + proj.passingTests + ' / ' + proj.totalTests + ' passing';
      if (proj.totalTests > 0) html += ' (' + pct(proj.passRate) + ')';
      html += ' · ' + proj.runCount + ' run' + (proj.runCount !== 1 ? 's' : '');
      html += '</div>';

      // Changes column (TestSprite signature pattern)
      html += '<div class="project-card__changes">';
      if (changes && (changes.newlyBroken.length > 0 || changes.newlyRecovered.length > 0)) {
        changes.newlyBroken.slice(0, 3).forEach(function (name) {
          html += '<span class="change-chip change-chip--broken" title="' + escHtml(name) + '">+1 broken</span>';
        });
        changes.newlyRecovered.slice(0, 3).forEach(function (name) {
          html += '<span class="change-chip change-chip--recovered" title="' + escHtml(name) + '">-1 broken</span>';
        });
        var overflow = (changes.newlyBroken.length - 3) + (changes.newlyRecovered.length - 3);
        if (overflow > 0) {
          html += '<span class="change-chip change-chip--overflow">+' + overflow + ' more</span>';
        }
      } else if (changes) {
        html += '<span style="font-size:0.72rem;color:var(--text-dim)">No changes</span>';
      } else {
        // changes loading or single run — show delta from health
        var delta = proj.delta;
        if (delta > 0) {
          html += '<span class="change-chip change-chip--recovered">+' + delta + ' recovered</span>';
        } else if (delta < 0) {
          html += '<span class="change-chip change-chip--broken">' + Math.abs(delta) + ' broken</span>';
        } else {
          html += '<span style="font-size:0.72rem;color:var(--text-dim)">—</span>';
        }
      }
      html += '</div>';

      html += '<div class="project-card__meta">';
      html += '<span class="project-card__time">Last: ' + escHtml(relativeTime(proj.lastRunAt)) + '</span>';
      html += '</div>';
      html += '</div>';
    });
    projectList.innerHTML = html;

    projectList.querySelectorAll('.project-card').forEach(function (card) {
      card.addEventListener('click', function (e) {
        if (e.target.tagName === 'A') return;
        var pp = card.getAttribute('data-project-path');
        showProjectPanel(pp, projects);
      });
    });
  }

  function loadChanges(projects) {
    var changesMap = {};
    var pending = projects.length;
    if (pending === 0) return Promise.resolve(changesMap);
    return new Promise(function (resolve) {
      projects.forEach(function (proj) {
        if (!proj.projectPath) { pending--; if (!pending) resolve(changesMap); return; }
        fetch('/api/changes?project=' + encodeURIComponent(proj.projectPath))
          .then(function (r) { return r.json(); })
          .then(function (d) { changesMap[proj.projectPath] = d; })
          .catch(function () { /* ignore, stub not yet available */ })
          .finally(function () { pending--; if (!pending) resolve(changesMap); });
      });
    });
  }

  function load() {
    Promise.all([
      fetch('/api/runs').then(function (r) { return r.json(); }),
      fetch('/api/projects').then(function (r) { return r.json(); }),
    ]).then(function (results) {
      allRuns = results[0];
      var projects = results[1];

      // Update live badge: count in-progress runs
      var inProgress = allRuns.filter(function (r) { return (r.status || r.outcome) === 'in-progress'; }).length;
      var liveBadge = document.getElementById('topbar-live');
      if (liveBadge) {
        if (inProgress > 0) {
          liveBadge.style.display = '';
          liveBadge.textContent = inProgress + ' run' + (inProgress !== 1 ? 's' : '') + ' in progress';
        } else {
          liveBadge.style.display = 'none';
        }
      }

      renderRunsList();

      // Load changes then render project cards
      loadChanges(projects).then(function (changesMap) {
        renderProjectList(projects, changesMap);
      });
    }).catch(function () {
      var runsListEl = document.getElementById('runs-list');
      if (runsListEl) runsListEl.innerHTML = '<div class="empty-state"><div class="empty-state__heading">Failed to load runs</div></div>';
    });
  }

  function showProjectPanel(projectPath, allProjects) {
    var proj = null;
    allProjects.forEach(function (p) { if (p.projectPath === projectPath) proj = p; });
    if (!proj) return;

    document.querySelectorAll('.project-card').forEach(function (c) {
      c.classList.toggle('active', c.getAttribute('data-project-path') === projectPath);
    });

    var projectRuns = allRuns.filter(function (r) { return r.project_path === projectPath; });

    var bodyHtml = '<div class="run-meta">' +
      '<div class="run-meta-item"><div class="run-meta-item__label">Status</div><div class="run-meta-item__value">' + pillHtml(proj.status) + '</div></div>' +
      '<div class="run-meta-item"><div class="run-meta-item__label">Pass rate</div><div class="run-meta-item__value">' + pct(proj.passRate) + '</div></div>' +
      '<div class="run-meta-item"><div class="run-meta-item__label">Last run</div><div class="run-meta-item__value">' + escHtml(relativeTime(proj.lastRunAt)) + '</div></div>' +
      '</div>';

    bodyHtml += '<div class="run-stats-bar">' +
      '<div class="stat-badge total"><div class="stat-badge__num">' + proj.totalTests + '</div><div class="stat-badge__label">Total</div></div>' +
      '<div class="stat-badge ok"><div class="stat-badge__num">' + proj.passingTests + '</div><div class="stat-badge__label">Passed</div></div>' +
      '<div class="stat-badge fail"><div class="stat-badge__num">' + (proj.totalTests - proj.passingTests) + '</div><div class="stat-badge__label">Failed</div></div>' +
      '</div>';

    if (projectRuns.length > 0) {
      bodyHtml += '<div class="section-title" style="margin-top:0.75rem">Run history</div>';
      bodyHtml += '<div class="card"><table class="runs-table">' +
        '<thead><tr><th>ID</th><th>Status</th><th>Started</th><th>Duration</th></tr></thead><tbody>';
      projectRuns.slice(0, 10).forEach(function (r) {
        var runId = String(r.id);
        var status = (r.outcome || r.status || 'in-progress').toLowerCase();
        bodyHtml += '<tr style="cursor:pointer" onclick="location.href=\'/runs/' + encodeURIComponent(runId) + '\'">' +
          '<td class="run-id-cell">' + escHtml(runId.slice(0, 10)) + '…</td>' +
          '<td>' + pillHtml(status) + '</td>' +
          '<td class="time-cell">' + escHtml(relativeTime(r.started_at)) + '</td>' +
          '<td class="time-cell">' + escHtml(formatMs(r.duration_ms)) + '</td>' +
          '</tr>';
      });
      bodyHtml += '</tbody></table></div>';
    }

    if (projectRuns.length >= 2) {
      var lastId = String(projectRuns[0].id);
      var prevId = String(projectRuns[1].id);
      bodyHtml += '<div style="margin-top:0.75rem">' +
        '<a class="btn" href="/compare?a=' + encodeURIComponent(prevId) + '&b=' + encodeURIComponent(lastId) + '">Compare last 2 runs →</a>' +
        '</div>';
    }

    openPanel(escHtml(proj.projectName), bodyHtml);
  }

  load();
  setInterval(load, 10000);
})();

// ── Run detail page ────────────────────────────────────────────────────────────

(function initRunDetail() {
  var runRoot = document.getElementById('run-root');
  if (!runRoot) return;

  wirePanel();

  var runId = runRoot.getAttribute('data-run-id');
  var status = runRoot.getAttribute('data-status');

  var run = {}, results = [];
  try {
    var tmp = document.createElement('div');
    tmp.innerHTML = runRoot.getAttribute('data-run') || '{}';
    run = JSON.parse(tmp.textContent || '{}');
  } catch (_) { run = {}; }
  try {
    var tmp2 = document.createElement('div');
    tmp2.innerHTML = runRoot.getAttribute('data-results') || '[]';
    results = JSON.parse(tmp2.textContent || '[]');
  } catch (_) { results = []; }

  var passed = 0, failed = 0, skipped = 0;
  results.forEach(function (r) {
    if (r.status === 'passed') passed++;
    else if (r.status === 'failed') failed++;
    else skipped++;
  });
  var total = results.length;

  // Render run header block
  var headerEl = document.getElementById('run-header');
  if (headerEl) {
    var headerHtml = pillHtml(status || 'in-progress');
    headerHtml += ' <span class="run-id-monospace">' + escHtml(String(runId || '')) + '</span>';
    if (run.projectPath) headerHtml += ' <span style="color:var(--text-dim)">·</span> ' + escHtml(projectLabel(run.projectPath));
    if (run.tool) headerHtml += ' <span style="color:var(--text-dim)">·</span> ' + escHtml(run.tool.replace('tspr_', '').replace(/_/g, ' '));
    if (run.durationMs) headerHtml += ' <span style="color:var(--text-dim)">·</span> ' + escHtml(formatMs(run.durationMs));
    if (run.startedAt) headerHtml += ' <span style="color:var(--text-dim)">·</span> ' + escHtml(relativeTime(run.startedAt));
    headerEl.innerHTML = headerHtml;
  }

  // Render stat badges
  var scenarioSectionEl = document.getElementById('scenario-section');
  if (!scenarioSectionEl) return;

  var html = '';

  if (total > 0) {
    html += '<div class="run-stats-bar">' +
      '<div class="stat-badge total"><div class="stat-badge__num">' + total + '</div><div class="stat-badge__label">Total</div></div>' +
      '<div class="stat-badge ok"><div class="stat-badge__num">' + passed + '</div><div class="stat-badge__label">Passed</div></div>' +
      '<div class="stat-badge fail"><div class="stat-badge__num">' + failed + '</div><div class="stat-badge__label">Failed</div></div>' +
      '<div class="stat-badge skip"><div class="stat-badge__num">' + skipped + '</div><div class="stat-badge__label">Skipped</div></div>' +
      '</div>';
  }

  // Scenario list as primary content (all results in one list, failures first)
  if (results.length > 0) {
    var failedRows = results.filter(function (r) { return r.status === 'failed'; });
    var passedRows = results.filter(function (r) { return r.status === 'passed'; });
    var skippedRows = results.filter(function (r) { return r.status === 'skipped'; });
    var ordered = failedRows.concat(passedRows).concat(skippedRows);

    html += '<div class="section"><div class="section-title">Scenarios (' + total + ')</div>';
    html += '<div class="scenario-list">';
    ordered.forEach(function (r) {
      var origIdx = results.indexOf(r);
      var icon = r.status === 'passed' ? '✅' : r.status === 'failed' ? '❌' : '⏭️';
      html += '<div class="scenario-row ' + escHtml(r.status) + '" data-result-idx="' + origIdx + '" role="button" tabindex="0">';
      html += '<span class="scenario-row__icon" aria-hidden="true">' + icon + '</span>';
      html += '<span class="scenario-row__name">' + escHtml(r.testName || r.testId) + '</span>';
      if (r.durationMs) html += '<span class="scenario-row__duration">' + formatMs(r.durationMs) + '</span>';
      html += '</div>';
    });
    html += '</div></div>';
  } else {
    html += '<div class="empty-state"><div class="empty-state__desc">No test results for this run.</div></div>';
  }

  scenarioSectionEl.innerHTML = html;

  scenarioSectionEl.querySelectorAll('.scenario-row').forEach(function (row) {
    var activate = function () {
      var idx = parseInt(row.getAttribute('data-result-idx'), 10);
      var result = results[idx];
      if (!result) return;
      showScenarioPanel(result);
    };
    row.addEventListener('click', activate);
    row.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } });
  });

  // Transparency panel: ONLY rendered when ?dev=1 is in URL
  var searchParams = new URLSearchParams(window.location.search);
  var devMode = searchParams.get('dev') === '1';
  var tpContainer = document.getElementById('transparency-panel');
  if (devMode && tpContainer && run.projectPath) {
    var tsprDir = (run.projectPath.replace(/\\/g, '/')) + '/.tspr/test_results.json';
    fetch('/api/file?path=' + encodeURIComponent(tsprDir))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.content) {
          renderTransparencyPanel(tpContainer, data.content);
        }
      }).catch(function () {});
  }

  if (status === 'in-progress') {
    var pollInterval = setInterval(function () {
      fetch('/api/runs/' + encodeURIComponent(runId))
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data && data.run && data.run.status !== 'in-progress') {
            clearInterval(pollInterval);
            location.reload();
          }
        }).catch(function () {});
    }, 3000);
  }

  function showScenarioPanel(result) {
    var fix = result.suggestedFixRegion;
    var bodyHtml = '<div style="margin-bottom:0.75rem">' + pillHtml(result.status) + '</div>';

    // Stack trace (collapsible)
    if (result.errorMessage) {
      bodyHtml += '<details class="scenario-details" open><summary class="section-title" style="cursor:pointer;user-select:none">Stack trace</summary>';
      bodyHtml += '<pre style="background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);padding:0.65rem;font-family:var(--font-mono);font-size:0.72rem;white-space:pre-wrap;max-height:200px;overflow-y:auto;margin-top:0.4rem;margin-bottom:0.75rem">' + escHtml(result.errorMessage) + '</pre>';
      bodyHtml += '</details>';
    }

    // Suggested fix region
    if (fix) {
      bodyHtml += '<div class="section-title" style="margin-top:0.75rem">Source file</div>';
      var fileLabel = fix.file;
      var normalized = fileLabel.replace(/\\/g, '/');
      var vsLink = 'vscode://file/' + normalized + (fix.lineStart ? ':' + fix.lineStart : '');
      bodyHtml += '<div style="margin-bottom:0.35rem">';
      bodyHtml += '<a class="issue-card__file-link" href="' + escHtml(vsLink) + '">' + escHtml(fileLabel);
      if (fix.lineStart) bodyHtml += ' L' + fix.lineStart;
      if (fix.lineEnd && fix.lineEnd !== fix.lineStart) bodyHtml += '–' + fix.lineEnd;
      bodyHtml += '</a>';
      bodyHtml += '</div>';
      if (fix.why) {
        bodyHtml += '<div class="issue-card__why">' + escHtml(fix.why) + '</div>';
      }
      var paneId = 'file-pane-run';
      bodyHtml += '<div id="' + paneId + '"><div style="color:var(--text-dim);font-size:0.75rem;padding:0.4rem">Loading…</div></div>';
      setTimeout(function () {
        fetch('/api/file?path=' + encodeURIComponent(fix.file))
          .then(function (r) { return r.json(); })
          .then(function (data) {
            var pane = document.getElementById(paneId);
            if (pane && data.content) pane.innerHTML = renderCodePane(data.content, fix.lineStart, fix.lineEnd);
            else if (pane) pane.innerHTML = '<div style="color:var(--text-dim);font-size:0.75rem">File not accessible.</div>';
          }).catch(function () {
            var pane = document.getElementById(paneId);
            if (pane) pane.innerHTML = '<div style="color:var(--text-dim);font-size:0.75rem">Could not load file.</div>';
          });
      }, 80);
    }

    // Suggested patch (diff colors)
    if (result.suggestedPatch) {
      bodyHtml += '<div class="section-title" style="margin-top:0.75rem">Suggested patch</div>';
      bodyHtml += renderPatch(result.suggestedPatch);
      bodyHtml += '<div style="margin-top:0.5rem;display:flex;gap:0.5rem;flex-wrap:wrap">';
      if (result.issueId && run.projectPath) {
        bodyHtml += '<button class="btn btn--apply-fix" id="run-apply-fix-btn" data-issue-id="' + escHtml(result.issueId || '') + '">Apply Fix</button>';
      }
      bodyHtml += '<button class="btn btn--view-diff" id="run-copy-patch-btn">Copy patch</button>';
      bodyHtml += '</div>';
    }

    openPanel(escHtml(result.testName || result.testId), bodyHtml);

    setTimeout(function () {
      var copyBtn = document.getElementById('run-copy-patch-btn');
      if (copyBtn) {
        copyBtn.addEventListener('click', function () { copyToClipboard(result.suggestedPatch, copyBtn); });
      }
      var applyFixBtn = document.getElementById('run-apply-fix-btn');
      if (applyFixBtn && run.projectPath) {
        applyFixBtn.addEventListener('click', function () {
          var fakeIssue = {
            issueId: applyFixBtn.getAttribute('data-issue-id') || result.issueId,
            projectPath: run.projectPath,
            suggestedPatch: result.suggestedPatch,
            testId: result.testId,
            title: result.testName || result.testId,
          };
          applyFix(fakeIssue, applyFixBtn, function (res) {
            applyFixBtn.insertAdjacentHTML('afterend',
              ' <button class="btn btn--push-pr" data-push-pr="rp" data-branch="' + escHtml(res.branch || '') + '">Push PR</button>' +
              ' <button class="btn btn--merge-local" data-merge-local="rp" data-branch="' + escHtml(res.branch || '') + '">Merge Local</button>'
            );
            wirePostActionBtns(applyFixBtn.parentElement, fakeIssue);
          });
        });
      }
    }, 50);
  }
})();

// ── Compare page ───────────────────────────────────────────────────────────────

(function initCompare() {
  var compareBtn = document.getElementById('compare-btn');
  if (!compareBtn) return;

  var inputA = document.getElementById('run-a-input');
  var inputB = document.getElementById('run-b-input');
  var params = new URLSearchParams(window.location.search);

  if (params.get('a') && inputA) inputA.value = params.get('a');
  if (params.get('b') && inputB) inputB.value = params.get('b');

  fetch('/api/runs').then(function (r) { return r.json(); }).then(function (runs) {
    var tbody = document.getElementById('recent-tbody');
    if (!tbody) return;
    if (!runs.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="color:var(--text-dim);padding:1rem">No runs yet.</td></tr>';
      return;
    }
    var html = '';
    runs.slice(0, 15).forEach(function (r) {
      var runId = String(r.id);
      var status = (r.outcome || r.status || 'in-progress').toLowerCase();
      html += '<tr>' +
        '<td class="run-id-cell">' + escHtml(runId.slice(0, 12)) + '</td>' +
        '<td>' + escHtml(projectLabel(r.project_path)) + '</td>' +
        '<td>' + pillHtml(status) + '</td>' +
        '<td class="time-cell">' + escHtml(relativeTime(r.started_at)) + '</td>' +
        '<td><button class="btn" data-fill-a="' + escHtml(runId) + '">Use as A</button></td>' +
        '<td><button class="btn" data-fill-b="' + escHtml(runId) + '">Use as B</button></td>' +
        '</tr>';
    });
    tbody.innerHTML = html;
    tbody.querySelectorAll('[data-fill-a]').forEach(function (btn) {
      btn.addEventListener('click', function () { inputA.value = btn.getAttribute('data-fill-a'); });
    });
    tbody.querySelectorAll('[data-fill-b]').forEach(function (btn) {
      btn.addEventListener('click', function () { inputB.value = btn.getAttribute('data-fill-b'); });
    });
  }).catch(function () {});

  compareBtn.addEventListener('click', runCompare);
  if (params.get('a') && params.get('b')) setTimeout(runCompare, 200);

  function runCompare() {
    var a = (inputA ? inputA.value : '').trim();
    var b = (inputB ? inputB.value : '').trim();
    var errEl = document.getElementById('compare-error');
    var resEl = document.getElementById('compare-results');
    if (!a || !b) {
      if (errEl) { errEl.style.display = 'block'; document.getElementById('compare-error-msg').textContent = 'Both run IDs are required.'; }
      if (resEl) resEl.style.display = 'none';
      return;
    }
    if (errEl) errEl.style.display = 'none';
    compareBtn.textContent = 'Loading…';
    compareBtn.disabled = true;

    fetch('/api/compare?a=' + encodeURIComponent(a) + '&b=' + encodeURIComponent(b))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        compareBtn.textContent = 'Compare';
        compareBtn.disabled = false;
        if (data.error) {
          if (errEl) { errEl.style.display = 'block'; document.getElementById('compare-error-msg').textContent = data.error; }
          if (resEl) resEl.style.display = 'none';
          return;
        }
        if (resEl) resEl.style.display = 'block';
        var sumEl = document.getElementById('compare-summary');
        if (sumEl) sumEl.textContent = 'Run ' + a.slice(0, 8) + '… vs ' + b.slice(0, 8) + '…';
        renderCol('fixed-list', 'fixed-label', data.fixed, 'Fixed');
        renderCol('new-list', 'new-label', data.newFailures, 'New failures');
        renderCol('still-list', 'still-label', data.stillFailing, 'Still failing');
      }).catch(function (e) {
        compareBtn.textContent = 'Compare';
        compareBtn.disabled = false;
        if (errEl) { errEl.style.display = 'block'; document.getElementById('compare-error-msg').textContent = 'Request failed: ' + e.message; }
      });
  }

  function renderCol(listId, labelId, items, label) {
    var labelEl = document.getElementById(labelId);
    var listEl  = document.getElementById(listId);
    if (labelEl) labelEl.textContent = label + ' (' + items.length + ')';
    if (!listEl) return;
    if (!items.length) { listEl.innerHTML = '<div class="compare-empty">None</div>'; return; }
    var html = '';
    items.forEach(function (t) { html += '<div class="compare-test">' + escHtml(t.test_name || t.test_id) + '</div>'; });
    listEl.innerHTML = html;
  }
})();

// ── Settings page ─────────────────────────────────────────────────────────────

(function initSettings() {
  var form = document.getElementById('settings-form');
  if (!form) return;

  var DEFAULT_CONFIG = {
    provider: 'claude-subprocess',
    baseUrl: '',
    apiKeyEnv: '',
    models: { haiku: '', sonnet: '', opus: '' },
  };

  function getFormValues() {
    var provider = (form.querySelector('input[name="provider"]:checked') || {}).value || 'claude-subprocess';
    return {
      provider: provider,
      baseUrl: (document.getElementById('base-url') || {}).value || '',
      apiKeyEnv: (document.getElementById('api-key-env') || {}).value || '',
      models: {
        haiku:  (document.getElementById('alias-haiku')  || {}).value || '',
        sonnet: (document.getElementById('alias-sonnet') || {}).value || '',
        opus:   (document.getElementById('alias-opus')   || {}).value || '',
      },
    };
  }

  function setFormValues(cfg) {
    var providerInputs = form.querySelectorAll('input[name="provider"]');
    providerInputs.forEach(function (inp) { inp.checked = inp.value === cfg.provider; });
    var baseUrl = document.getElementById('base-url');
    if (baseUrl) baseUrl.value = cfg.baseUrl || '';
    var apiKeyEnv = document.getElementById('api-key-env');
    if (apiKeyEnv) apiKeyEnv.value = cfg.apiKeyEnv || '';
    var haikuEl = document.getElementById('alias-haiku');
    if (haikuEl) haikuEl.value = (cfg.models && cfg.models.haiku) || '';
    var sonnetEl = document.getElementById('alias-sonnet');
    if (sonnetEl) sonnetEl.value = (cfg.models && cfg.models.sonnet) || '';
    var opusEl = document.getElementById('alias-opus');
    if (opusEl) opusEl.value = (cfg.models && cfg.models.opus) || '';
    updateFieldVisibility();
  }

  function updateFieldVisibility() {
    var provider = (form.querySelector('input[name="provider"]:checked') || {}).value || '';
    var needsUrl = provider === 'openai-compat' || provider === 'minimax';
    var fieldBase = document.getElementById('field-base-url');
    var fieldKey  = document.getElementById('field-api-key-env');
    var fieldAliases = document.getElementById('field-model-aliases');
    if (fieldBase) fieldBase.style.display = needsUrl ? '' : 'none';
    if (fieldKey) fieldKey.style.display = provider !== 'claude-subprocess' ? '' : 'none';
    if (fieldAliases) fieldAliases.style.display = provider !== 'claude-subprocess' ? '' : 'none';
  }

  // Wire provider radio buttons
  form.querySelectorAll('input[name="provider"]').forEach(function (inp) {
    inp.addEventListener('change', updateFieldVisibility);
  });

  // Load current config from server
  fetch('/api/settings')
    .then(function (r) { return r.json(); })
    .then(function (cfg) { setFormValues(cfg); })
    .catch(function () { setFormValues(DEFAULT_CONFIG); });

  // Reset button
  var resetBtn = document.getElementById('reset-btn');
  if (resetBtn) {
    resetBtn.addEventListener('click', function () {
      setFormValues(DEFAULT_CONFIG);
    });
  }

  // Save
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var saveBtn = document.getElementById('save-btn');
    var errEl = document.getElementById('settings-error');
    if (saveBtn) { saveBtn.textContent = 'Saving…'; saveBtn.disabled = true; }
    if (errEl) errEl.style.display = 'none';

    var payload = getFormValues();

    postJson('/api/settings', payload)
      .then(function (r) {
        if (saveBtn) { saveBtn.textContent = 'Save'; saveBtn.disabled = false; }
        if (r.ok) {
          showToast('✓ Settings saved', true);
          // Reload from server to confirm effective config
          fetch('/api/settings').then(function (res) { return res.json(); }).then(setFormValues).catch(function () {});
        } else {
          var msg = (r.body && r.body.error) ? r.body.error : 'Save failed';
          if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
        }
      })
      .catch(function (err) {
        if (saveBtn) { saveBtn.textContent = 'Save'; saveBtn.disabled = false; }
        if (errEl) { errEl.textContent = 'Network error: ' + err.message; errEl.style.display = 'block'; }
      });
  });
})();

// ── Cost page ──────────────────────────────────────────────────────────────────

(function initCost() {
  var costEl = document.getElementById('cost-total');
  if (!costEl) return;

  fetch('/api/stats').then(function (r) { return r.json(); }).then(function (s) {
    costEl.textContent = s.totalRuns;
    var avgEl = document.getElementById('cost-avg-pass');
    if (avgEl) avgEl.textContent = pct(s.avgPassRate);
    var testsEl = document.getElementById('cost-tests');
    if (testsEl) testsEl.textContent = s.totalTestsRun;
    var fEl = document.getElementById('cost-forecast');
    if (fEl) fEl.textContent = 'Not tracked';
  }).catch(function () {});

  fetch('/api/trends?days=30').then(function (r) { return r.json(); }).then(function (trends) {
    var chart = document.getElementById('daily-chart');
    if (chart) renderDailyChart(chart, trends);
  }).catch(function () {});

  fetch('/api/projects').then(function (r) { return r.json(); }).then(function (projects) {
    var tbody = document.getElementById('project-cost-tbody');
    if (!tbody) return;
    if (!projects.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="color:var(--text-dim);padding:1rem">No projects.</td></tr>';
      return;
    }
    var html = '';
    projects.forEach(function (proj) {
      html += '<tr>' +
        '<td>' + escHtml(proj.projectName) + '</td>' +
        '<td>' + proj.runCount + '</td>' +
        '<td>' + proj.totalTests + '</td>' +
        '<td>' + pct(proj.passRate) + '</td>' +
        '<td class="time-cell">' + escHtml(relativeTime(proj.lastRunAt)) + '</td>' +
        '</tr>';
    });
    tbody.innerHTML = html;
  }).catch(function () {});
})();
