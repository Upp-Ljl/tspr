/* tspr dashboard — app.js  (vanilla, no deps) */
'use strict';

// ── Home page ──────────────────────────────────────────────────────────────────
(function initHome() {
  const tableBody = document.getElementById('runs-body');
  if (!tableBody) return; // not the home page

  // Initial data was injected into the page as window.__RUNS__
  let allRuns = window.__RUNS__ || [];
  let statusFilter = 'all';
  let searchQuery = '';

  // ── Filter button wiring ───────────────────────────────────────────────────
  document.querySelectorAll('[data-filter]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      statusFilter = btn.getAttribute('data-filter');
      document.querySelectorAll('[data-filter]').forEach(function (b) {
        b.classList.toggle('active', b === btn);
      });
      renderTable();
    });
  });

  // ── Search wiring ──────────────────────────────────────────────────────────
  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    searchInput.addEventListener('input', function () {
      searchQuery = searchInput.value.toLowerCase().trim();
      renderTable();
    });
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  function renderTable() {
    const filtered = allRuns.filter(function (r) {
      if (statusFilter !== 'all') {
        const st = (r.outcome || r.status || '').toLowerCase();
        if (statusFilter === 'passing' && st !== 'ok') return false;
        if (statusFilter === 'failing' && st !== 'error' && st !== 'all-failed') return false;
        if (statusFilter === 'partial' && st !== 'partial') return false;
      }
      if (searchQuery) {
        const haystack = [
          r.id, r.tool, r.project_path, r.session_id
        ].filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(searchQuery)) return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      tableBody.innerHTML =
        '<tr><td colspan="7">' +
        '<div class="empty">' +
        '<div class="empty__icon">📭</div>' +
        '<div class="empty__msg">No runs found</div>' +
        '<div class="empty__sub">Runs appear here after you call a tspr MCP tool.</div>' +
        '</div></td></tr>';
      return;
    }

    tableBody.innerHTML = filtered.map(function (r) {
      const status = (r.outcome || r.status || 'in-progress').toLowerCase();
      const pillCls = pillClass(status);
      const pillLabel = pillText(status);
      const project = projectLabel(r.project_path);
      const runId = String(r.id || '');
      const displayId = runId.length > 16 ? runId.slice(0, 16) + '…' : runId;
      const started = r.started_at ? relativeTime(r.started_at) : '—';
      const duration = r.duration_ms != null ? formatMs(r.duration_ms) : '—';

      return '<tr onclick="location.href=\'/runs/' + encodeURIComponent(runId) + '\'">' +
        '<td><span class="run-id" title="' + escHtml(runId) + '">' + escHtml(displayId) + '</span></td>' +
        '<td><span class="project-name" title="' + escHtml(r.project_path || '') + '">' + escHtml(project) + '</span></td>' +
        '<td><span class="pill ' + pillCls + '">' + pillLabel + '</span></td>' +
        '<td class="stats">' + toolLabel(r.tool) + '</td>' +
        '<td class="time-cell">' + escHtml(started) + '</td>' +
        '<td class="time-cell">' + escHtml(duration) + '</td>' +
        '<td class="time-cell">' + escHtml(r.error_code || '') + '</td>' +
        '</tr>';
    }).join('');
  }

  // ── Polling for live updates ───────────────────────────────────────────────
  let pollTimer = null;
  function startPoll() {
    pollTimer = setInterval(function () {
      fetch('/api/runs')
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (!Array.isArray(data)) return;
          // Only re-render if data changed (simple length+first-id check)
          if (
            data.length !== allRuns.length ||
            (data[0] && allRuns[0] && data[0].id !== allRuns[0].id) ||
            (data[0] && allRuns[0] && data[0].outcome !== allRuns[0].outcome)
          ) {
            allRuns = data;
            renderTable();
          }
        })
        .catch(function () { /* ignore transient failures */ });
    }, 5000);
  }

  renderTable();
  startPoll();
})();

// ── Run detail page ────────────────────────────────────────────────────────────
(function initDetail() {
  const detailRoot = document.getElementById('detail-root');
  if (!detailRoot) return;

  // Toggle failure cards open/closed
  document.addEventListener('click', function (e) {
    const header = e.target.closest('.failure-card__header');
    if (!header) return;
    const card = header.closest('.failure-card');
    if (card) card.classList.toggle('open');
  });

  // Poll for live refresh of in-progress runs
  const runId = detailRoot.getAttribute('data-run-id');
  if (!runId) return;

  const initialStatus = detailRoot.getAttribute('data-status') || '';
  if (initialStatus === 'in-progress') {
    const pollInterval = setInterval(function () {
      fetch('/api/runs/' + encodeURIComponent(runId))
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (data && data.outcome && data.outcome !== 'in-progress') {
            clearInterval(pollInterval);
            location.reload();
          }
        })
        .catch(function () {});
    }, 3000);
  }
})();

// ── Utilities ──────────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pillClass(status) {
  const map = {
    ok: 'pill--ok',
    partial: 'pill--partial',
    failed: 'pill--failed',
    'all-failed': 'pill--all-failed',
    error: 'pill--error',
    'in-progress': 'pill--in-progress',
    skipped: 'pill--skipped',
  };
  return map[status] || 'pill--in-progress';
}

function pillText(status) {
  const map = {
    ok: '✓ ok',
    partial: '⚠ partial',
    failed: '✗ failed',
    'all-failed': '✗ all-failed',
    error: '✗ error',
    'in-progress': '⟳ running',
    skipped: '— skipped',
  };
  return map[status] || status;
}

function projectLabel(projectPath) {
  if (!projectPath) return '—';
  const parts = projectPath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || projectPath;
}

function toolLabel(tool) {
  if (!tool) return '—';
  return tool.replace('tspr_', '').replace(/_/g, ' ');
}

function relativeTime(iso) {
  if (!iso) return '—';
  const delta = (Date.now() - new Date(iso).getTime()) / 1000;
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
