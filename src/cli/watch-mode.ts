/**
 * src/cli/watch-mode.ts
 *
 * Watch mode for tspr dashboard: watches source files in the target project
 * and re-runs only the failing scenarios that reference the changed file.
 *
 * Usage (internal — called by dashboard-command when --watch is set):
 *   startWatchMode({ projectPath, onTrigger })
 *
 * Watches: <project>/app, <project>/src, <project>/lib
 * (configurable via `watchDirs` option)
 *
 * Ignores: node_modules, .git, .next, dist, .tspr, __pycache__
 *
 * Debounce: 1 second. On change, identifies which failing scenarios reference
 * the changed file via test_results.json failures[].suggestedFixRegion.file,
 * then calls the onTrigger callback with those scenario IDs.
 */

import fs from 'node:fs';
import path from 'node:path';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WatchModeOptions {
  /** Absolute path to the target project */
  projectPath: string;
  /**
   * Subdirectories of projectPath to watch.
   * Defaults to ['app', 'src', 'lib'].
   */
  watchDirs?: string[];
  /**
   * Called when a file change triggers a re-run.
   * @param changedFile — absolute path of the changed file
   * @param affectedIssueIds — stable issue IDs whose suggestedFixRegion.file
   *   matches the changed file (empty array = re-run all failures)
   */
  onTrigger: (changedFile: string, affectedIssueIds: string[]) => void | Promise<void>;
  /** Log function. Defaults to process.stdout.write */
  log?: (msg: string) => void;
}

export interface WatchHandle {
  /** Stop all watchers */
  stop: () => void;
}

// ─── Ignored path fragments ───────────────────────────────────────────────────

const IGNORED_SEGMENTS = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  '.tspr',
  '__pycache__',
  '.cache',
]);

function isIgnored(filePath: string): boolean {
  const parts = filePath.replace(/\\/g, '/').split('/');
  return parts.some((p) => IGNORED_SEGMENTS.has(p));
}

// ─── StoredResult shape ────────────────────────────────────────────────────────

interface StoredFailure {
  testId: string;
  issueId?: string;
  suggestedFixRegion?: {
    file: string;
    lineStart: number;
    lineEnd: number;
    why: string;
  };
}

interface StoredResult {
  failures?: StoredFailure[];
}

// ─── Identify affected scenarios ─────────────────────────────────────────────

/**
 * Given a changed file path, load test_results.json and return the issue IDs
 * of failures whose suggestedFixRegion.file matches (normalized comparison).
 */
function getAffectedIssueIds(changedFile: string, projectPath: string): string[] {
  const resultsPath = path.join(projectPath, '.tspr', 'test_results.json');
  if (!fs.existsSync(resultsPath)) return [];

  let stored: StoredResult;
  try {
    stored = JSON.parse(fs.readFileSync(resultsPath, 'utf-8')) as StoredResult;
  } catch {
    return [];
  }

  if (!stored.failures || stored.failures.length === 0) return [];

  const changedNorm = path.normalize(changedFile).replace(/\\/g, '/').toLowerCase();

  const matched: string[] = [];
  for (const f of stored.failures) {
    if (!f.suggestedFixRegion?.file) continue;

    // The stored file may be relative (to project) or absolute
    let storedAbs = f.suggestedFixRegion.file;
    if (!path.isAbsolute(storedAbs)) {
      storedAbs = path.join(projectPath, storedAbs);
    }
    const storedNorm = path.normalize(storedAbs).replace(/\\/g, '/').toLowerCase();

    if (storedNorm === changedNorm) {
      const id = f.issueId ?? f.testId;
      matched.push(id);
    }
  }
  return matched;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function startWatchMode(opts: WatchModeOptions): WatchHandle {
  const {
    projectPath,
    watchDirs = ['app', 'src', 'lib'],
    onTrigger,
    log = (msg: string) => { process.stdout.write(msg); },
  } = opts;

  const watchers: fs.FSWatcher[] = [];
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingFile: string | null = null;

  function handleChange(changedFile: string): void {
    if (isIgnored(changedFile)) return;

    pendingFile = changedFile;

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const file = pendingFile;
      pendingFile = null;
      debounceTimer = null;

      if (!file) return;

      const affected = getAffectedIssueIds(file, projectPath);
      const relFile = path.relative(projectPath, file).replace(/\\/g, '/');

      if (affected.length > 0) {
        log(`[watch] change in ${relFile} → re-running ${affected.length} failing scenario(s)...\n`);
      } else {
        log(`[watch] change in ${relFile} → no matching failures; re-running all failing scenarios...\n`);
      }

      Promise.resolve(onTrigger(file, affected)).catch((err: unknown) => {
        log(`[watch] trigger error: ${String(err)}\n`);
      });
    }, 1000);
  }

  // Watch each configured subdirectory (skip if it doesn't exist)
  let watchedCount = 0;
  for (const dir of watchDirs) {
    const absDir = path.join(projectPath, dir);
    if (!fs.existsSync(absDir)) continue;

    try {
      const watcher = fs.watch(absDir, { recursive: true }, (_eventType, filename) => {
        if (!filename) return;
        handleChange(path.join(absDir, filename));
      });
      watchers.push(watcher);
      watchedCount++;
    } catch {
      // Directory may not be watchable — skip silently
    }
  }

  if (watchedCount > 0) {
    log(`[watch] Watching ${watchedCount} director${watchedCount === 1 ? 'y' : 'ies'} in ${projectPath}\n`);
    log(`[watch] Dirs: ${watchDirs.filter((d) => fs.existsSync(path.join(projectPath, d))).join(', ')}\n`);
  } else {
    log(`[watch] Warning: no watchable directories found in ${projectPath} (looked for: ${watchDirs.join(', ')})\n`);
  }

  return {
    stop(): void {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      for (const w of watchers) {
        try { w.close(); } catch { /* ignore */ }
      }
      watchers.length = 0;
      log('[watch] Stopped.\n');
    },
  };
}
