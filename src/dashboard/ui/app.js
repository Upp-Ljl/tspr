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

  html += '<div class="issue-card__actions">';
  if (issue.suggestedPatch) {
    html += '<button class="btn btn--accent" data-copy-patch="' + idx + '">Copy patch</button>';
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

// ── Home page ──────────────────────────────────────────────────────────────────

(function initHome() {
  var projectList = document.getElementById('project-list');
  if (!projectList) return;

  wirePanel();

  var issuesData = [];
  var historyOpen = false;

  var histToggle = document.getElementById('history-toggle');
  var histPanel  = document.getElementById('history-panel');
  var histCaret  = document.getElementById('history-caret');
  if (histToggle) {
    histToggle.addEventListener('click', function () {
      historyOpen = !historyOpen;
      if (histPanel) histPanel.style.display = historyOpen ? 'block' : 'none';
      if (histCaret) histCaret.textContent = historyOpen ? '▲ hide' : '▼ show';
    });
  }

  function load() {
    // Stats
    fetch('/api/stats').then(function (r) { return r.json(); }).then(function (stats) {
      var el = document.getElementById('stat-runs');
      if (el) el.textContent = stats.totalRuns;
      var el2 = document.getElementById('stat-tests');
      if (el2) el2.textContent = stats.totalTestsRun;
      var el3 = document.getElementById('stat-pass-rate');
      if (el3) el3.textContent = pct(stats.avgPassRate);
    }).catch(function () {});

    // Projects
    fetch('/api/projects').then(function (r) { return r.json(); }).then(function (projects) {
      var countEl = document.getElementById('projects-count');
      var statsEl = document.getElementById('stat-projects');
      if (countEl) countEl.textContent = projects.length;
      if (statsEl) statsEl.textContent = projects.length;

      if (projects.length === 0) {
        projectList.innerHTML = '<div class="empty-state">' +
          '<div class="empty-state__heading">No runs yet</div>' +
          '<div class="empty-state__desc">tspr hasn\'t run yet. Get started:</div>' +
          '<pre class="empty-state__code">// In Claude Code, register the MCP server:\ntspr mcp\n\n// Then call from cc:\ntspr_bootstrap_tests({ projectPath: "./your-project" })</pre>' +
          '</div>';
        return;
      }

      var html = '';
      projects.forEach(function (proj) {
        var delta = proj.delta;
        var deltaClass = delta > 0 ? 'pos' : delta < 0 ? 'neg' : 'flat';
        var deltaStr = delta > 0 ? '+' + delta : delta < 0 ? String(delta) : '';
        var isStale = proj.lastRunAt && (Date.now() - new Date(proj.lastRunAt).getTime()) > 3 * 24 * 60 * 60 * 1000;

        html += '<div class="project-card" data-project-path="' + escHtml(proj.projectPath || '') + '">';
        html += '<div class="project-card__top">';
        html += '<span class="project-card__status-dot">' + statusDot(proj.status) + '</span>';
        html += '<span class="project-card__name">' + escHtml(proj.projectName) + '</span>';
        html += pillHtml(proj.status);
        html += '</div>';
        html += '<div class="project-card__stats">' + proj.passingTests + ' / ' + proj.totalTests + ' passing';
        if (proj.totalTests > 0) html += ' (' + pct(proj.passRate) + ')';
        html += '</div>';
        html += '<div class="project-card__meta">';
        html += '<span class="project-card__time">' + escHtml(relativeTime(proj.lastRunAt)) + '</span>';
        if (delta !== 0 && deltaStr) {
          html += '<span class="project-card__delta ' + deltaClass + '">' + escHtml(deltaStr) + ' since last</span>';
        }
        if (isStale) html += '<span class="stale-badge">stale</span>';
        html += '<a class="project-card__open" href="' + escHtml('file:///' + (proj.projectPath || '').replace(/\\/g, '/')) + '" title="Open folder">Open ↗</a>';
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
    }).catch(function () {
      projectList.innerHTML = '<div class="empty-state"><div class="empty-state__heading">Failed to load projects</div></div>';
    });

    // Issues
    fetch('/api/issues?limit=5').then(function (r) { return r.json(); }).then(function (issues) {
      issuesData = issues;
      renderIssuesList(issues);
    }).catch(function () {});

    // Trends
    fetch('/api/trends?days=30').then(function (r) { return r.json(); }).then(function (trends) {
      var sparkline = document.getElementById('trend-sparkline');
      if (sparkline) renderSparkline(sparkline, trends);
    }).catch(function () {});

    // Runs history
    fetch('/api/runs').then(function (r) { return r.json(); }).then(function (runs) {
      var countEl = document.getElementById('history-count');
      if (countEl) countEl.textContent = runs.length;
      renderRunsTable(runs);
    }).catch(function () {});
  }

  function renderIssuesList(issues) {
    var countEl = document.getElementById('issues-count');
    var listEl  = document.getElementById('issues-list');
    if (!listEl) return;

    var visible = issues.filter(function (i) { return isVisible(i.testId); });
    if (countEl) countEl.textContent = visible.length;

    if (visible.length === 0) {
      listEl.innerHTML = '<div class="empty-state">' +
        '<div class="empty-state__heading">No active issues</div>' +
        '<div class="empty-state__desc">All tests passing, or issues have been snoozed.</div>' +
        '</div>';
      return;
    }

    var html = '';
    visible.forEach(function (issue, i) { html += buildIssueCard(issue, i); });
    listEl.innerHTML = html;

    listEl.querySelectorAll('.issue-card__header').forEach(function (header) {
      header.addEventListener('click', function () {
        header.closest('.issue-card').classList.toggle('open');
      });
    });

    listEl.querySelectorAll('[data-copy-patch]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var idx = parseInt(btn.getAttribute('data-copy-patch'), 10);
        var issue = visible[idx];
        if (issue && issue.suggestedPatch) copyToClipboard(issue.suggestedPatch, btn);
      });
    });

    listEl.querySelectorAll('[data-copy-path]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var idx = parseInt(btn.getAttribute('data-copy-path'), 10);
        var issue = visible[idx];
        if (issue && issue.suggestedFixRegion) copyToClipboard(issue.suggestedFixRegion.file, btn);
      });
    });

    listEl.querySelectorAll('[data-mark-fixed]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        markFixed(btn.getAttribute('data-mark-fixed'));
        renderIssuesList(issuesData);
      });
    });

    listEl.querySelectorAll('[data-snooze]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        snoozeIssue(btn.getAttribute('data-snooze'));
        renderIssuesList(issuesData);
      });
    });
  }

  function renderRunsTable(runs) {
    var tbody = document.getElementById('runs-tbody');
    if (!tbody) return;
    if (!runs.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-dim);padding:1.5rem">No runs yet.</td></tr>';
      return;
    }
    var html = '';
    runs.slice(0, 50).forEach(function (r) {
      var runId = String(r.id || '');
      var displayId = runId.length > 12 ? runId.slice(0, 12) + '…' : runId;
      var status = (r.outcome || r.status || 'in-progress').toLowerCase();
      html += '<tr onclick="location.href=\'/runs/' + encodeURIComponent(runId) + '\'">' +
        '<td><span class="run-id-cell" title="' + escHtml(runId) + '">' + escHtml(displayId) + '</span></td>' +
        '<td>' + escHtml(projectLabel(r.project_path || null)) + '</td>' +
        '<td>' + pillHtml(status) + '</td>' +
        '<td style="color:var(--text-dim);font-size:0.78rem">' + escHtml((r.tool || '').replace('tspr_', '').replace(/_/g, ' ')) + '</td>' +
        '<td class="time-cell">' + escHtml(relativeTime(r.started_at)) + '</td>' +
        '<td class="time-cell">' + escHtml(formatMs(r.duration_ms)) + '</td>' +
        '</tr>';
    });
    tbody.innerHTML = html;
  }

  function showProjectPanel(projectPath, allProjects) {
    var proj = null;
    allProjects.forEach(function (p) { if (p.projectPath === projectPath) proj = p; });
    if (!proj) return;

    document.querySelectorAll('.project-card').forEach(function (c) {
      c.classList.toggle('active', c.getAttribute('data-project-path') === projectPath);
    });

    fetch('/api/runs').then(function (r) { return r.json(); }).then(function (runs) {
      var projectRuns = runs.filter(function (r) { return r.project_path === projectPath; });

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
    }).catch(function () {
      openPanel(escHtml(proj.projectName), '<div class="empty-state"><div class="empty-state__heading">Failed to load runs</div></div>');
    });
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
    // data-run is HTML-escaped JSON; decode via textContent trick
    var tmp = document.createElement('div');
    tmp.innerHTML = runRoot.getAttribute('data-run') || '{}';
    run = JSON.parse(tmp.textContent || '{}');
  } catch (_) { run = {}; }
  try {
    var tmp2 = document.createElement('div');
    tmp2.innerHTML = runRoot.getAttribute('data-results') || '[]';
    results = JSON.parse(tmp2.textContent || '[]');
  } catch (_) { results = []; }

  // Render detail UI into the page
  var container = document.createElement('div');

  var passed = 0, failed = 0, skipped = 0;
  (results || []).forEach(function (r) {
    if (r.status === 'passed') passed++;
    else if (r.status === 'failed') failed++;
    else skipped++;
  });
  var total = results.length;

  var html = '<div class="page-title">Run <span>' + escHtml(String(runId || '')) + '</span></div>';

  html += '<div class="run-meta">' +
    '<div class="run-meta-item"><div class="run-meta-item__label">Status</div><div class="run-meta-item__value">' + pillHtml(status || 'in-progress') + '</div></div>' +
    '<div class="run-meta-item"><div class="run-meta-item__label">Project</div><div class="run-meta-item__value">' + escHtml(projectLabel(run.projectPath)) + '</div></div>' +
    '<div class="run-meta-item"><div class="run-meta-item__label">Tool</div><div class="run-meta-item__value">' + escHtml((run.tool || '').replace('tspr_', '').replace(/_/g, ' ')) + '</div></div>' +
    '<div class="run-meta-item"><div class="run-meta-item__label">Started</div><div class="run-meta-item__value">' + escHtml(relativeTime(run.startedAt)) + '</div></div>' +
    '<div class="run-meta-item"><div class="run-meta-item__label">Duration</div><div class="run-meta-item__value">' + escHtml(formatMs(run.durationMs)) + '</div></div>' +
    (run.errorCode ? '<div class="run-meta-item"><div class="run-meta-item__label">Error</div><div class="run-meta-item__value" style="color:var(--red)">' + escHtml(run.errorCode) + '</div></div>' : '') +
    '</div>';

  if (total > 0) {
    html += '<div class="run-stats-bar">' +
      '<div class="stat-badge total"><div class="stat-badge__num">' + total + '</div><div class="stat-badge__label">Total</div></div>' +
      '<div class="stat-badge ok"><div class="stat-badge__num">' + passed + '</div><div class="stat-badge__label">Passed</div></div>' +
      '<div class="stat-badge fail"><div class="stat-badge__num">' + failed + '</div><div class="stat-badge__label">Failed</div></div>' +
      '<div class="stat-badge skip"><div class="stat-badge__num">' + skipped + '</div><div class="stat-badge__label">Skipped</div></div>' +
      '</div>';
  }

  if (results.length > 0) {
    var failedRows = results.filter(function (r) { return r.status === 'failed'; });
    var passedRows = results.filter(function (r) { return r.status === 'passed'; });
    var skippedRows = results.filter(function (r) { return r.status === 'skipped'; });

    function renderRows(rows) {
      return rows.map(function (r, i) {
        var origIdx = results.indexOf(r);
        return '<div class="test-row ' + escHtml(r.status) + '" data-result-idx="' + origIdx + '">' +
          '<span class="test-row__name">' + escHtml(r.testName || r.testId) + '</span>' +
          (r.durationMs ? '<span class="test-row__duration">' + formatMs(r.durationMs) + '</span>' : '') +
          '</div>';
      }).join('');
    }

    if (failedRows.length > 0) {
      html += '<div class="section"><div class="section-title">Failures (' + failedRows.length + ')</div><div class="test-list">' + renderRows(failedRows) + '</div></div>';
    }
    if (passedRows.length > 0) {
      html += '<div class="section"><div class="section-title">Passed (' + passedRows.length + ')</div><div class="test-list">' + renderRows(passedRows) + '</div></div>';
    }
    if (skippedRows.length > 0) {
      html += '<div class="section"><div class="section-title">Skipped (' + skippedRows.length + ')</div><div class="test-list">' + renderRows(skippedRows) + '</div></div>';
    }
  } else {
    html += '<div class="empty-state"><div class="empty-state__desc">No test results for this run.</div></div>';
  }

  container.innerHTML = html;
  runRoot.appendChild(container);

  container.querySelectorAll('.test-row').forEach(function (row) {
    row.addEventListener('click', function () {
      var idx = parseInt(row.getAttribute('data-result-idx'), 10);
      var result = results[idx];
      if (!result) return;
      showTestPanel(result);
    });
  });

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

  function showTestPanel(result) {
    var fix = result.suggestedFixRegion;
    var bodyHtml = '<div style="margin-bottom:0.75rem">' + pillHtml(result.status) + '</div>';

    if (result.errorMessage) {
      bodyHtml += '<div class="section-title">Error / stack trace</div>';
      bodyHtml += '<pre style="background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);padding:0.65rem;font-family:var(--font-mono);font-size:0.72rem;white-space:pre-wrap;max-height:200px;overflow-y:auto;margin-bottom:0.75rem">' + escHtml(result.errorMessage) + '</pre>';
    }

    if (result.suggestedPatch) {
      bodyHtml += '<div class="section-title">Suggested patch</div>';
      bodyHtml += renderPatch(result.suggestedPatch);
      bodyHtml += '<div style="margin-top:0.5rem;display:flex;gap:0.5rem;flex-wrap:wrap">';
      bodyHtml += '<button class="btn btn--accent" id="run-copy-patch-btn">Copy patch</button>';
      bodyHtml += '<button class="btn" id="run-apply-btn">How to apply…</button>';
      bodyHtml += '</div>';
      bodyHtml += '<div id="run-apply-div" style="display:none;margin-top:0.5rem;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);padding:0.65rem;font-family:var(--font-mono);font-size:0.72rem;color:var(--text)">';
      bodyHtml += '# Save the patch text to a file, then:\ngit apply the.patch\n# or:\npatch -p1 &lt; the.patch';
      bodyHtml += '</div>';
    }

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

      // Load after panel opens
      setTimeout(function () {
        fetch('/api/file?path=' + encodeURIComponent(fix.file))
          .then(function (r) { return r.json(); })
          .then(function (data) {
            var pane = document.getElementById(paneId);
            if (pane && data.content) {
              pane.innerHTML = renderCodePane(data.content, fix.lineStart, fix.lineEnd);
            } else if (pane) {
              pane.innerHTML = '<div style="color:var(--text-dim);font-size:0.75rem">File not accessible (outside allowed paths).</div>';
            }
          }).catch(function () {
            var pane = document.getElementById(paneId);
            if (pane) pane.innerHTML = '<div style="color:var(--text-dim);font-size:0.75rem">Could not load file.</div>';
          });
      }, 80);
    }

    openPanel(escHtml(result.testName || result.testId), bodyHtml);

    setTimeout(function () {
      var copyBtn = document.getElementById('run-copy-patch-btn');
      if (copyBtn) {
        copyBtn.addEventListener('click', function () {
          copyToClipboard(result.suggestedPatch, copyBtn);
        });
      }
      var applyBtn = document.getElementById('run-apply-btn');
      var applyDiv = document.getElementById('run-apply-div');
      if (applyBtn && applyDiv) {
        applyBtn.addEventListener('click', function () {
          applyDiv.style.display = applyDiv.style.display === 'none' ? 'block' : 'none';
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
