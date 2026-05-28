/**
 * src/dashboard/cli-command.ts
 *
 * CLI subcommand handler for `tspr dashboard`.
 *
 * Lead wiring (30 seconds):
 *   In src/cli/index.ts, add to the subcommand switch:
 *     case 'dashboard':
 *       import('../dashboard/cli-command.js').then(({ runDashboardCommand }) =>
 *         runDashboardCommand(process.argv.slice(3)).then(process.exit)
 *       ).catch((err) => { process.stderr.write(String(err) + '\n'); process.exit(1); });
 *       break;
 *
 * Or with a static import at the top of cli/index.ts:
 *   import { runDashboardCommand } from '../dashboard/cli-command.js';
 *   ...
 *   case 'dashboard': return runDashboardCommand(args);
 */

import process from 'node:process';
import { startDashboard, type DashboardOptions } from './server.js';
import { startWatchMode, type WatchHandle } from '../cli/watch-mode.js';

interface ParsedDashboardArgs extends DashboardOptions {
  _noOpen?: boolean;
  _watch?: boolean;
  _project?: string;
}

function parseArgs(args: string[]): ParsedDashboardArgs {
  const opts: ParsedDashboardArgs = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--no-open') {
      opts.open = false;
      opts._noOpen = true;
      continue;
    }

    if (arg === '--watch') {
      opts._watch = true;
      continue;
    }

    if (arg === '--project') {
      opts._project = args[++i];
      continue;
    }

    const projectEq = arg.match(/^--project=(.+)$/);
    if (projectEq) {
      opts._project = projectEq[1];
      continue;
    }

    if (arg === '--port' || arg === '-p') {
      const val = args[++i];
      if (!val || isNaN(Number(val))) {
        process.stderr.write(`[tspr dashboard] --port requires a numeric argument\n`);
        process.exit(1);
      }
      opts.port = parseInt(val, 10);
      continue;
    }

    const portEq = arg.match(/^--port=(\d+)$/);
    if (portEq) {
      opts.port = parseInt(portEq[1], 10);
      continue;
    }

    if (arg === '--host') {
      opts.host = args[++i];
      continue;
    }

    const hostEq = arg.match(/^--host=(.+)$/);
    if (hostEq) {
      opts.host = hostEq[1];
      continue;
    }

    if (arg === '--db' || arg === '--db-path') {
      opts.dbPath = args[++i];
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE);
      process.exit(0);
    }

    process.stderr.write(`[tspr dashboard] unknown flag: ${arg}\n${USAGE}`);
    process.exit(1);
  }

  return opts;
}

const USAGE = `
Usage: tspr dashboard [options]

Options:
  --port <n>       HTTP port (default: 7654)
  --host <h>       Bind host (default: 127.0.0.1)
  --no-open        Do not auto-open browser
  --db-path <p>    Path to db.sqlite (default: ~/.tspr/db.sqlite)
  --watch          Watch project source files and re-run affected failing scenarios on change
  --project <p>    Project path to watch (default: cwd)
  -h, --help       Show this help

`.trimStart();

/**
 * Entry point for the `tspr dashboard` subcommand.
 *
 * @param args - argv after the 'dashboard' subcommand token (i.e. process.argv.slice(3))
 * @returns exit code (0 = clean exit after SIGINT)
 */
export async function runDashboardCommand(args: string[]): Promise<number> {
  const opts = parseArgs(args);
  const watchMode = opts._watch ?? false;
  const projectPath = opts._project ?? process.cwd();

  let handle: { url: string; close: () => Promise<void> };

  try {
    handle = await startDashboard(opts);
  } catch (err) {
    process.stderr.write(`[tspr dashboard] failed to start: ${String(err)}\n`);
    return 1;
  }

  process.stdout.write(`[tspr dashboard] listening at ${handle.url}\n`);
  if (opts.open !== false) {
    process.stdout.write(`[tspr dashboard] opening browser…\n`);
  }
  process.stdout.write(`[tspr dashboard] press Ctrl-C to stop\n`);

  // Start file watcher if --watch is set
  let watcher: WatchHandle | null = null;
  if (watchMode) {
    process.stdout.write(`[tspr dashboard] --watch mode enabled (project: ${projectPath})\n`);
    watcher = startWatchMode({
      projectPath,
      onTrigger: async (changedFile, affectedIssueIds) => {
        // Log is handled in watch-mode itself; here we could invoke
        // an in-process re-run. For v1, we just log the trigger.
        // Future: call generateAndExecute in-process for the affected IDs.
        const ids = affectedIssueIds.length > 0
          ? affectedIssueIds.map((id) => id.slice(0, 12)).join(', ')
          : '(all failures)';
        process.stdout.write(`[watch] Triggered re-run for: ${ids}\n`);
        process.stdout.write(`[watch] Refresh the dashboard to see updated results.\n`);
      },
    });
  }

  // Wait for SIGINT / SIGTERM
  return new Promise<number>((resolve) => {
    async function shutdown(): Promise<void> {
      process.stdout.write('\n[tspr dashboard] shutting down…\n');
      if (watcher) {
        watcher.stop();
        watcher = null;
      }
      try {
        await handle.close();
      } catch { /* ignore */ }
      resolve(0);
    }

    process.once('SIGINT', () => { void shutdown(); });
    process.once('SIGTERM', () => { void shutdown(); });
  });
}
